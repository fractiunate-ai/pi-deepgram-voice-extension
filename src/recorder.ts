import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import { formatDevice, loadVoiceSettings, type AudioInputDevice } from "./settings.js";

export class RecorderError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "RecorderError";
  }
}

export interface RecordingSession {
  audioPath: string;
  stop: () => Promise<string>;
  abort: () => Promise<void>;
}

export interface StreamingRecordingSession extends RecordingSession {
  stream: Readable;
  begin: () => void;
}

interface RecorderCommand {
  command: string;
  args: string[];
  installHint: string;
}

const AUDIO_FORMAT_ARGS = ["-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer"];

function soxInstallHint(): string {
  return [
    "SoX (`rec` or `sox`) is required for audio recording.",
    "Install SoX, then restart Pi:",
    "  macOS:  brew install sox",
    "  Debian/Ubuntu/WSL: sudo apt-get install sox libsox-fmt-all pulseaudio-utils alsa-utils",
    "  Windows native: winget install ChrisBagwell.SoX",
    "Note: when Pi runs inside WSL, the microphone must be available inside WSL/PulseAudio.",
  ].join("\n");
}

async function commandExists(command: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", () => resolve(true));
  });
}

async function resolveRecorder(audioPath: string, device: AudioInputDevice): Promise<RecorderCommand> {
  const installHint = soxInstallHint();

  if (device.kind === "pulse") {
    if (await commandExists("sox")) {
      return {
        command: "sox",
        args: ["-q", "-t", "pulseaudio", device.id, ...AUDIO_FORMAT_ARGS, audioPath],
        installHint,
      };
    }
    throw new RecorderError(installHint);
  }

  if (device.kind === "alsa") {
    if (await commandExists("sox")) {
      return {
        command: "sox",
        args: ["-q", "-t", "alsa", device.id, ...AUDIO_FORMAT_ARGS, audioPath],
        installHint,
      };
    }
    throw new RecorderError(installHint);
  }

  if (await commandExists("rec")) {
    return {
      command: "rec",
      args: ["-q", ...AUDIO_FORMAT_ARGS, audioPath],
      installHint,
    };
  }

  if (await commandExists("sox")) {
    if (process.platform === "win32") {
      return {
        command: "sox",
        args: ["-q", "-t", "waveaudio", "default", ...AUDIO_FORMAT_ARGS, audioPath],
        installHint,
      };
    }

    return {
      command: "sox",
      args: ["-q", "-d", ...AUDIO_FORMAT_ARGS, audioPath],
      installHint,
    };
  }

  throw new RecorderError(installHint);
}

async function resolveStreamingRecorder(device: AudioInputDevice): Promise<RecorderCommand> {
  const installHint = soxInstallHint();

  if (device.kind === "pulse") {
    if (await commandExists("sox")) {
      return {
        command: "sox",
        args: ["-q", "-t", "pulseaudio", device.id, ...AUDIO_FORMAT_ARGS, "-t", "raw", "-"],
        installHint,
      };
    }
    throw new RecorderError(installHint);
  }

  if (device.kind === "alsa") {
    if (await commandExists("sox")) {
      return {
        command: "sox",
        args: ["-q", "-t", "alsa", device.id, ...AUDIO_FORMAT_ARGS, "-t", "raw", "-"],
        installHint,
      };
    }
    throw new RecorderError(installHint);
  }

  if (await commandExists("rec")) {
    return {
      command: "rec",
      args: ["-q", ...AUDIO_FORMAT_ARGS, "-t", "raw", "-"],
      installHint,
    };
  }

  if (await commandExists("sox")) {
    if (process.platform === "win32") {
      return {
        command: "sox",
        args: ["-q", "-t", "waveaudio", "default", ...AUDIO_FORMAT_ARGS, "-t", "raw", "-"],
        installHint,
      };
    }

    return {
      command: "sox",
      args: ["-q", "-d", ...AUDIO_FORMAT_ARGS, "-t", "raw", "-"],
      installHint,
    };
  }

  throw new RecorderError(installHint);
}

export async function startRecording(audioPath: string): Promise<RecordingSession> {
  const settings = await loadVoiceSettings();
  const recorder = await resolveRecorder(audioPath, settings.device);
  return startRecorderProcess(audioPath, recorder, settings.device);
}

export async function startStreamingRecording(audioPath: string): Promise<StreamingRecordingSession> {
  const settings = await loadVoiceSettings();
  const recorder = await resolveStreamingRecorder(settings.device);
  const session = await startRecorderProcess(audioPath, recorder, settings.device, true);
  if (!session.stream || !session.begin) {
    throw new RecorderError("Streaming recorder did not expose an audio stream.");
  }
  return session as StreamingRecordingSession;
}

async function startRecorderProcess(
  audioPath: string,
  recorder: RecorderCommand,
  device: AudioInputDevice,
  streaming = false,
): Promise<RecordingSession & { stream?: Readable; begin?: () => void }> {
  let processError: Error | undefined;
  let stderr = "";
  let closed = false;
  let closeCode: number | null = null;
  let child: ChildProcess;

  try {
    child = spawn(recorder.command, recorder.args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new RecorderError(`Failed to start microphone recorder.\n${recorder.installHint}`, error);
  }

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  child.once("error", (error) => {
    processError = error;
  });

  const closePromise = new Promise<void>((resolve) => {
    child.once("close", (code) => {
      closed = true;
      closeCode = code;
      resolve();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const readyTimer = setTimeout(resolve, 250);
    child.once("error", (error) => {
      clearTimeout(readyTimer);
      reject(new RecorderError(`Failed to start microphone recorder.\n${recorder.installHint}`, error));
    });
    child.once("exit", (code) => {
      clearTimeout(readyTimer);
      if (code !== null && code !== 0) {
        reject(new RecorderError(`Microphone recording failed to start using ${formatDevice(device)}${stderr ? `:\n${stderr.trim()}` : "."}\nUse /voicesettings to choose another microphone.\n${recorder.installHint}`));
      } else {
        resolve();
      }
    });
  });

  const stdout = child.stdout ?? undefined;
  const stream = streaming && stdout ? new PassThrough() : stdout;
  const archive = streaming && stdout ? createWriteStream(audioPath) : undefined;
  let streamingStarted = false;

  if (streaming && stdout) stdout.pause();

  archive?.on("error", (error) => {
    processError = error;
  });

  const begin = streaming && stdout && stream && archive
    ? () => {
        if (streamingStarted) return;
        streamingStarted = true;
        stdout.pipe(stream as PassThrough);
        stdout.pipe(archive);
      }
    : undefined;

  async function stopProcess(): Promise<void> {
    if (!closed) {
      child.kill("SIGINT");
      const forceKill = setTimeout(() => {
        if (!closed) child.kill("SIGTERM");
      }, 1500);
      await closePromise.finally(() => clearTimeout(forceKill));
    }
    if (archive && !archive.closed) {
      archive.end();
      await once(archive, "close").catch(() => undefined);
    }
  }

  return {
    audioPath,
    stream,
    begin,
    stop: async () => {
      await stopProcess();
      if (processError) {
        throw new RecorderError(`Microphone recording failed: ${processError.message}`, processError);
      }
      if (closeCode !== null && closeCode !== 0 && closeCode !== 130) {
        throw new RecorderError(`Microphone recording failed using ${formatDevice(device)}${stderr ? `:\n${stderr.trim()}` : "."}\nUse /voicesettings to choose another microphone.`);
      }
      return audioPath;
    },
    abort: async () => {
      await stopProcess();
    },
  };
}
