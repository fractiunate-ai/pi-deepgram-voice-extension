import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { transcribeFile } from "./deepgram.js";
import { startRecording, type RecordingSession } from "./recorder.js";
import { createTempAudioFile } from "./temp.js";

const STATUS_KEY = "deepgram-voice";
const WIDGET_KEY = "deepgram-voice";
const SHORTCUT = "alt+j";

type VoiceContext = ExtensionCommandContext;

interface ActiveRecording {
  session: RecordingSession;
  endUi?: () => void;
}

let activeRecording: ActiveRecording | undefined;
let starting = false;

export default function (pi: ExtensionAPI) {
  async function runVoice(ctx: VoiceContext): Promise<void> {
    if (activeRecording) {
      activeRecording.endUi?.();
      return;
    }

    if (starting) {
      ctx.ui.notify("Voice recording is already starting...", "warning");
      return;
    }

    if (!process.env.DEEPGRAM_API_KEY) {
      ctx.ui.notify("DEEPGRAM_API_KEY is missing. Export it before launching Pi.", "error");
      return;
    }

    if (ctx.mode !== "tui") {
      ctx.ui.notify("/voice requires the interactive Pi TUI.", "error");
      return;
    }

    starting = true;
    const temp = await createTempAudioFile();

    try {
      ctx.ui.setStatus(STATUS_KEY, "🎙 recording");
      ctx.ui.setWidget(WIDGET_KEY, [
        "🎙 Deepgram voice recording active",
        `Press Enter, Escape, or ${SHORTCUT} to stop and transcribe.`,
      ]);

      const session = await startRecording(temp.path);
      activeRecording = { session };
      starting = false;

      await waitForStop(ctx);

      ctx.ui.setStatus(STATUS_KEY, "🎙 transcribing");
      ctx.ui.setWidget(WIDGET_KEY, ["🎙 Recording stopped", "Transcribing with Deepgram..."]);

      const audioPath = await session.stop();
      activeRecording = undefined;

      const transcript = await transcribeFile(audioPath);
      ctx.ui.notify(`Voice transcript: ${transcript}`, "info");

      if (ctx.isIdle()) {
        pi.sendUserMessage(transcript);
      } else {
        pi.sendUserMessage(transcript, { deliverAs: "followUp" });
        ctx.ui.notify("Agent is busy; queued voice transcript as follow-up.", "info");
      }
    } catch (error) {
      const recordingToAbort = activeRecording;
      activeRecording = undefined;
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(message, "error");
      try {
        await recordingToAbort?.session.abort();
      } catch {
        // Best-effort cleanup only.
      }
    } finally {
      starting = false;
      activeRecording = undefined;
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      await temp.cleanup();
    }
  }

  pi.registerCommand("voice", {
    description: "Record microphone audio, transcribe it with Deepgram, and send it as a user message",
    handler: async (_args, ctx) => {
      await runVoice(ctx);
    },
  });

  pi.registerShortcut(SHORTCUT, {
    description: "Toggle Deepgram voice input",
    handler: async (ctx) => {
      await runVoice(ctx as VoiceContext);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(`Deepgram voice loaded: /voice or ${SHORTCUT}`, "info");
  });
}

async function waitForStop(ctx: VoiceContext): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const lines = [
      theme.fg("accent", "🎙 Deepgram voice recording"),
      "",
      "Speak now.",
      "",
      theme.fg("muted", `Press Enter, Escape, or ${SHORTCUT} to stop.`),
    ];

    const finish = () => {
      done();
      return true;
    };

    activeRecording!.endUi = () => done();

    return {
      render: () => lines,
      invalidate: () => {},
      handleInput: (key: string) => {
        if (matchesKey(key, Key.enter) || matchesKey(key, Key.escape) || matchesKey(key, SHORTCUT)) {
          return finish();
        }
        tui.requestRender();
        return true;
      },
    };
  });
}
