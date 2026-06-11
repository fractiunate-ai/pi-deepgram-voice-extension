import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { startLiveTranscription, transcribeFile, type LiveTranscriptionSession } from "./deepgram.js";
import { startRecording, startStreamingRecording, type RecordingSession } from "./recorder.js";
import { createTempAudioFile } from "./temp.js";
import { formatDevice, listAudioInputDevices, loadVoiceSettings, saveVoiceSettings } from "./settings.js";

const STATUS_KEY = "deepgram-voice";
const WIDGET_KEY = "deepgram-voice";
const SHORTCUT = "alt+j";

type VoiceContext = ExtensionCommandContext;

interface ActiveRecording {
  session: RecordingSession;
  endUi?: () => void;
  stopRequested?: boolean;
}

let activeRecording: ActiveRecording | undefined;
let starting = false;

export default function (pi: ExtensionAPI) {
  async function runVoice(ctx: VoiceContext): Promise<void> {
    if (activeRecording) {
      activeRecording.stopRequested = true;
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
    let temp: Awaited<ReturnType<typeof createTempAudioFile>> | undefined;
    let live: LiveTranscriptionSession | undefined;

    try {
      temp = await createTempAudioFile();
      let liveTranscript = "";
      let requestUiRender: (() => void) | undefined;

      ctx.ui.setStatus(STATUS_KEY, "🎙 connecting");
      ctx.ui.setWidget(WIDGET_KEY, ["🎙 Connecting to Deepgram live transcription..."]);

      try {
        live = await startLiveTranscription((transcript) => {
          liveTranscript = transcript;
          ctx.ui.setWidget(WIDGET_KEY, widgetLines("recording", liveTranscript));
          requestUiRender?.();
        });

        const session = await startStreamingRecording(temp.rawPath);
        activeRecording = { session };
        session.stream.on("data", (chunk: Buffer) => live?.sendAudio(chunk));
        session.begin();
        starting = false;

        ctx.ui.setStatus(STATUS_KEY, "🎙 live");
        ctx.ui.setWidget(WIDGET_KEY, widgetLines("recording", liveTranscript));

        await waitForStop(ctx, () => liveTranscript, (render) => {
          requestUiRender = render;
        });

        ctx.ui.setStatus(STATUS_KEY, "🎙 finalizing");
        ctx.ui.setWidget(WIDGET_KEY, widgetLines("finalizing", liveTranscript));

        const audioPath = await session.stop();
        activeRecording = undefined;

        let transcript: string;
        try {
          transcript = await live.finalize();
        } catch (error) {
          ctx.ui.notify(`Live transcription failed; falling back to prerecorded transcription. ${formatError(error)}`, "warning");
          transcript = await transcribeFile(audioPath, { rawLinear16: true });
        }

        await submitTranscript(pi, ctx, transcript);
      } catch (error) {
        live?.close();
        await abortActiveRecording();

        ctx.ui.notify(`Live recording failed; falling back to prerecorded recording. ${formatError(error)}`, "warning");
        await runPrerecordedFallback(pi, ctx, temp.path);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(message, "error");
      await abortActiveRecording();
    } finally {
      live?.close();
      starting = false;
      activeRecording = undefined;
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      await temp?.cleanup();
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

  pi.registerCommand("voicesettings", {
    description: "Select the microphone input used by Deepgram voice recording",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "show") {
        const settings = await loadVoiceSettings();
        ctx.ui.notify(`Voice microphone: ${formatDevice(settings.device)}`, "info");
        return;
      }

      if (action === "reset") {
        const [defaultDevice] = await listAudioInputDevices();
        await saveVoiceSettings({ device: defaultDevice });
        ctx.ui.notify(`Voice microphone reset to ${formatDevice(defaultDevice)}`, "info");
        return;
      }

      const settings = await loadVoiceSettings();
      const devices = await listAudioInputDevices();
      const labels = devices.map((device, index) => {
        const current = device.kind === settings.device.kind && device.id === settings.device.id ? "current — " : "";
        return `${index + 1}. ${current}${formatDevice(device)}`;
      });

      const choice = await ctx.ui.select("Select microphone input for /voice", labels);
      if (!choice) {
        ctx.ui.notify("Voice microphone selection cancelled", "info");
        return;
      }

      const index = labels.indexOf(choice);
      const device = devices[index];
      if (!device) {
        ctx.ui.notify("Could not resolve selected microphone", "error");
        return;
      }

      await saveVoiceSettings({ device });
      ctx.ui.notify(`Voice microphone set to ${formatDevice(device)}`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(`Deepgram voice loaded: /voice or ${SHORTCUT}`, "info");
  });
}

async function runPrerecordedFallback(pi: ExtensionAPI, ctx: VoiceContext, audioPath: string): Promise<void> {
  ctx.ui.setStatus(STATUS_KEY, "🎙 recording");
  ctx.ui.setWidget(WIDGET_KEY, [
    "🎙 Prerecorded fallback recording active",
    `Press Enter, Escape, or ${SHORTCUT} to stop and transcribe.`,
  ]);

  const session = await startRecording(audioPath);
  activeRecording = { session };
  starting = false;

  await waitForStop(ctx, () => "", () => undefined);

  ctx.ui.setStatus(STATUS_KEY, "🎙 transcribing");
  ctx.ui.setWidget(WIDGET_KEY, ["🎙 Recording stopped", "Transcribing with Deepgram fallback..."]);

  const recordedPath = await session.stop();
  activeRecording = undefined;
  const transcript = await transcribeFile(recordedPath);
  await submitTranscript(pi, ctx, transcript);
}

async function submitTranscript(pi: ExtensionAPI, ctx: VoiceContext, transcript: string): Promise<void> {
  ctx.ui.notify(`Voice transcript: ${transcript}`, "info");

  if (ctx.isIdle()) {
    pi.sendUserMessage(transcript);
  } else {
    pi.sendUserMessage(transcript, { deliverAs: "followUp" });
    ctx.ui.notify("Agent is busy; queued voice transcript as follow-up.", "info");
  }
}

async function waitForStop(
  ctx: VoiceContext,
  getTranscript: () => string,
  onRenderReady: (requestRender: () => void) => void,
): Promise<void> {
  if (activeRecording?.stopRequested) return;

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const finish = () => {
      if (activeRecording) activeRecording.stopRequested = true;
      done();
      return true;
    };

    activeRecording!.endUi = finish;
    onRenderReady(() => tui.requestRender());

    return {
      render: () => [
        theme.fg("accent", "🎙 Deepgram voice recording"),
        "",
        "Speak now.",
        "",
        ...formatTranscriptLines(getTranscript(), theme),
        "",
        theme.fg("muted", `Press Enter, Escape, or ${SHORTCUT} to stop.`),
      ],
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

function widgetLines(state: "recording" | "finalizing", transcript: string): string[] {
  const header = state === "recording" ? "🎙 Deepgram live recording active" : "🎙 Finalizing Deepgram transcript...";
  return [header, transcript ? `Transcript: ${transcript}` : "Transcript will appear as you speak.", `Press Enter, Escape, or ${SHORTCUT} to stop.`];
}

function formatTranscriptLines(transcript: string, theme: Parameters<Parameters<VoiceContext["ui"]["custom"]>[0]>[1]): string[] {
  if (!transcript) return [theme.fg("muted", "Transcript will appear here as Deepgram streams it...")];
  return [theme.fg("muted", "Live transcript:"), transcript];
}

async function abortActiveRecording(): Promise<void> {
  const recordingToAbort = activeRecording;
  activeRecording = undefined;
  try {
    await recordingToAbort?.session.abort();
  } catch {
    // Best-effort cleanup only.
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
