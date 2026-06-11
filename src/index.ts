import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { startLiveTranscription, transcribeFile, type LiveTranscriptionSession } from "./deepgram.js";
import { startRecording, startStreamingRecording, type RecordingSession } from "./recorder.js";
import { createTempAudioFile } from "./temp.js";
import { defaultVoiceSettings, formatDevice, listAudioInputDevices, loadVoiceSettings, saveVoiceSettings, type VoiceSettings } from "./settings.js";

const STATUS_KEY = "deepgram-voice";
const WIDGET_KEY = "deepgram-voice";
const SHORTCUT = "alt+j";

type VoiceContext = ExtensionCommandContext;
type TranscriptDisposition = "send" | "editor";

interface ActiveRecording {
  session: RecordingSession;
  startedAt: number;
  editorPrefix: string;
  endUi?: (disposition?: TranscriptDisposition) => void;
  stopRequested?: boolean;
  disposition?: TranscriptDisposition;
}

let activeRecording: ActiveRecording | undefined;
let starting = false;

export default function (pi: ExtensionAPI) {
  async function runVoice(ctx: VoiceContext, activeDisposition: TranscriptDisposition = "send"): Promise<void> {
    if (activeRecording) {
      activeRecording.stopRequested = true;
      activeRecording.disposition = activeDisposition;
      activeRecording.endUi?.(activeDisposition);
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
      setVoiceWidget(ctx, "connecting", "");

      try {
        let session: Awaited<ReturnType<typeof startStreamingRecording>>;
        let pendingSession: ReturnType<typeof startStreamingRecording> | undefined;
        try {
          pendingSession = startStreamingRecording(temp.rawPath);
          const [startedLive, startedSession] = await Promise.all([
            startLiveTranscription((transcript) => {
              liveTranscript = transcript;
              if (activeRecording) setEditorDraft(ctx, activeRecording.editorPrefix, liveTranscript);
              setVoiceWidget(ctx, "recording", liveTranscript);
              requestUiRender?.();
            }),
            pendingSession,
          ]);
          live = startedLive;
          session = startedSession;
          activeRecording = { session, startedAt: Date.now(), editorPrefix: ctx.ui.getEditorText() };
        } catch (error) {
          const session = await pendingSession?.catch(() => undefined);
          await session?.abort();
          throw error;
        }
        session.stream.on("data", (chunk: Buffer) => live?.sendAudio(chunk));
        session.begin();
        starting = false;

        ctx.ui.setStatus(STATUS_KEY, "🎙 live");
        setVoiceWidget(ctx, "recording", liveTranscript);

        await waitForStop(ctx, () => liveTranscript, (render) => {
          requestUiRender = render;
        });

        ctx.ui.setStatus(STATUS_KEY, "🎙 finalizing");
        setVoiceWidget(ctx, "finalizing", liveTranscript);

        const audioPath = await session.stop();
        const recording = activeRecording;
        const disposition = recording?.disposition ?? "send";
        activeRecording = undefined;

        let transcript: string;
        try {
          transcript = await live.finalize();
        } catch (error) {
          if (shouldCloseSilently(error, recording?.startedAt)) return;
          ctx.ui.notify(`Live transcription failed; falling back to prerecorded transcription. ${formatError(error)}`, "warning");
          try {
            transcript = await transcribeFile(audioPath, { rawLinear16: true });
          } catch (fallbackError) {
            if (shouldCloseSilently(fallbackError, recording?.startedAt)) return;
            throw fallbackError;
          }
        }

        await submitTranscript(pi, ctx, transcript, disposition, recording?.editorPrefix);
      } catch (error) {
        if (shouldCloseSilently(error, activeRecording?.startedAt)) {
          live?.close();
          await abortActiveRecording();
          return;
        }

        live?.close();
        await abortActiveRecording();

        ctx.ui.notify(`Live recording failed; falling back to prerecorded recording. ${formatError(error)}`, "warning");
        await runPrerecordedFallback(pi, ctx, temp.path);
      }
    } catch (error) {
      if (shouldCloseSilently(error, (activeRecording as ActiveRecording | undefined)?.startedAt)) {
        await abortActiveRecording();
        return;
      }
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
      await runVoice(ctx as VoiceContext, "editor");
    },
  });

  pi.registerCommand("voicesettings", {
    description: "Configure Deepgram voice recording settings (microphone, model, language)",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      const settings = await loadVoiceSettings();

      if (action === "show") {
        ctx.ui.notify(formatVoiceSettings(settings), "info");
        return;
      }

      if (action === "reset") {
        await saveVoiceSettings(defaultVoiceSettings());
        ctx.ui.notify("Voice settings reset to defaults.", "info");
        return;
      }

      const selectedAction = action || await ctx.ui.select("Voice settings", [
        "microphone — select audio input",
        "model — edit Deepgram model",
        "language — edit transcription language",
        "show — display current settings",
        "reset — restore defaults",
      ]);
      if (!selectedAction) {
        ctx.ui.notify("Voice settings cancelled", "info");
        return;
      }

      if (selectedAction.startsWith("show")) {
        ctx.ui.notify(formatVoiceSettings(settings), "info");
        return;
      }

      if (selectedAction.startsWith("reset")) {
        await saveVoiceSettings(defaultVoiceSettings());
        ctx.ui.notify("Voice settings reset to defaults.", "info");
        return;
      }

      if (selectedAction.startsWith("model")) {
        const model = await promptVoiceSetting(ctx, "Deepgram model", settings.model, ["nova-3", "nova-2", "enhanced", "base"]);
        if (!model) return;
        await saveVoiceSettings({ ...settings, model });
        ctx.ui.notify(`Voice Deepgram model set to ${model}`, "info");
        return;
      }

      if (selectedAction.startsWith("language")) {
        const language = await promptVoiceSetting(ctx, "Deepgram language", settings.language, ["en-US", "en", "en-GB", "es", "fr", "de", "it", "pt", "nl", "ja", "ko", "zh"]);
        if (!language) return;
        await saveVoiceSettings({ ...settings, language });
        ctx.ui.notify(`Voice Deepgram language set to ${language}`, "info");
        return;
      }

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

      await saveVoiceSettings({ ...settings, device });
      ctx.ui.notify(`Voice microphone set to ${formatDevice(device)}`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(`Deepgram voice loaded: /voice or ${SHORTCUT}`, "info");
  });
}

function formatVoiceSettings(settings: VoiceSettings): string {
  return [
    `Voice microphone: ${formatDevice(settings.device)}`,
    `Deepgram model: ${process.env.DEEPGRAM_MODEL ? `${process.env.DEEPGRAM_MODEL} (from DEEPGRAM_MODEL env)` : settings.model}`,
    `Deepgram language: ${process.env.DEEPGRAM_LANGUAGE ? `${process.env.DEEPGRAM_LANGUAGE} (from DEEPGRAM_LANGUAGE env)` : settings.language}`,
  ].join("\n");
}

async function promptVoiceSetting(ctx: VoiceContext, label: string, current: string, presets: string[]): Promise<string | undefined> {
  const choices = [...presets.map((value) => value === current ? `current — ${value}` : value), "custom..."];
  const choice = await ctx.ui.select(`${label} (current: ${current})`, choices);
  if (!choice) {
    ctx.ui.notify(`${label} unchanged`, "info");
    return undefined;
  }

  if (choice === "custom...") {
    const value = await ctx.ui.input(label, current);
    const trimmed = value?.trim();
    if (!trimmed) {
      ctx.ui.notify(`${label} unchanged`, "info");
      return undefined;
    }
    return trimmed;
  }

  return choice.replace(/^current — /, "").trim();
}

async function runPrerecordedFallback(pi: ExtensionAPI, ctx: VoiceContext, audioPath: string): Promise<void> {
  ctx.ui.setStatus(STATUS_KEY, "🎙 recording");
  setVoiceWidget(ctx, "fallback-recording", "");

  const session = await startRecording(audioPath);
  activeRecording = { session, startedAt: Date.now(), editorPrefix: ctx.ui.getEditorText() };
  starting = false;

  await waitForStop(ctx, () => "", () => undefined);

  ctx.ui.setStatus(STATUS_KEY, "🎙 transcribing");
  setVoiceWidget(ctx, "fallback-transcribing", "");

  const recordedPath = await session.stop();
  const recording = activeRecording;
  const disposition = recording?.disposition ?? "send";
  activeRecording = undefined;
  try {
    const transcript = await transcribeFile(recordedPath);
    await submitTranscript(pi, ctx, transcript, disposition, recording?.editorPrefix);
  } catch (error) {
    if (shouldCloseSilently(error, recording?.startedAt)) return;
    throw error;
  }
}

async function submitTranscript(
  pi: ExtensionAPI,
  ctx: VoiceContext,
  transcript: string,
  disposition: TranscriptDisposition = "send",
  editorPrefix?: string,
): Promise<void> {
  if (disposition === "editor") {
    setEditorDraft(ctx, editorPrefix ?? ctx.ui.getEditorText(), transcript);
    ctx.ui.notify("Voice transcript inserted into the prompt editor.", "info");
    return;
  }

  if (editorPrefix !== undefined) ctx.ui.setEditorText(editorPrefix);
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
    const finish = (disposition: TranscriptDisposition = "send") => {
      if (activeRecording) {
        activeRecording.stopRequested = true;
        activeRecording.disposition = disposition;
      }
      clearInterval(renderTimer);
      done();
      return true;
    };

    activeRecording!.endUi = finish;
    const renderTimer = setInterval(() => tui.requestRender(), 1000);
    onRenderReady(() => tui.requestRender());

    return {
      render: (width: number) => {
        const safeWidth = Math.max(1, width);
        return [truncateToWidth(theme.fg("muted", `${SHORTCUT} insert into editor • Enter/Escape send`), safeWidth)];
      },
      invalidate: () => {},
      dispose: () => clearInterval(renderTimer),
      handleInput: (key: string) => {
        if (matchesKey(key, SHORTCUT)) {
          return finish("editor");
        }
        if (matchesKey(key, Key.enter) || matchesKey(key, Key.escape)) {
          return finish("send");
        }
        tui.requestRender();
        return true;
      },
    };
  }, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%" } });
}

type WidgetState = "connecting" | "recording" | "finalizing" | "fallback-recording" | "fallback-transcribing";

function setVoiceWidget(ctx: VoiceContext, state: WidgetState, transcript: string): void {
  ctx.ui.setWidget(WIDGET_KEY, () => ({
    render: (width: number) => widgetLines(state, transcript, width),
    invalidate: () => {},
  }));
}

function widgetLines(state: WidgetState, transcript: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const elapsed = activeRecording?.startedAt ? ` (${formatElapsed(activeRecording.startedAt)})` : "";
  const header = (() => {
    switch (state) {
      case "connecting": return "🎙 Connecting to Deepgram live transcription...";
      case "recording": return `🎙 Voice input active${elapsed}`;
      case "finalizing": return `🎙 Finalizing Deepgram transcript${elapsed}...`;
      case "fallback-recording": return `🎙 Prerecorded fallback recording active${elapsed}`;
      case "fallback-transcribing": return "🎙 Recording stopped";
    }
  })();

  const body = (() => {
    switch (state) {
      case "connecting": return "";
      case "fallback-transcribing": return "Transcribing with Deepgram fallback...";
      case "recording":
      case "finalizing": return "";
      case "fallback-recording": return `Press Enter, Escape, or ${SHORTCUT} to stop and transcribe.`;
    }
  })();

  return [
    truncateToWidth(header, safeWidth),
    ...wrapTextWithAnsi(body, safeWidth).filter(Boolean).map((line) => truncateToWidth(line, safeWidth)),
  ];
}

function setEditorDraft(ctx: VoiceContext, editorPrefix: string, transcript: string): void {
  const cleanedTranscript = transcript.trim();
  if (!cleanedTranscript) {
    ctx.ui.setEditorText(editorPrefix);
    return;
  }
  ctx.ui.setEditorText(editorPrefix.trim() ? `${editorPrefix}\n${cleanedTranscript}` : cleanedTranscript);
}

function shouldCloseSilently(error: unknown, startedAt?: number): boolean {
  const message = formatError(error).toLowerCase();
  const elapsedMs = startedAt ? Date.now() - startedAt : undefined;
  const isVeryShortRecording = elapsedMs === undefined || elapsedMs < 2000;
  return (
    message.includes("empty live transcript") ||
    message.includes("empty transcript") ||
    message.includes("audio file is empty or too short") ||
    (isVeryShortRecording && message.includes("corrupt or unsupported data"))
  );
}

function formatElapsed(startedAt?: number): string {
  if (!startedAt) return "00:00";
  const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
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
