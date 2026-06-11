import { spawn, type ChildProcess } from "node:child_process";

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

interface RecorderCommand {
  command: string;
  args: string[];
  installHint: string;
}

function soxInstallHint(): string {
  return [
    "The `rec` command from SoX is required for audio recording.",
    "Install SoX, then restart Pi:",
    "  macOS:  brew install sox",
    "  Debian/Ubuntu/WSL: sudo apt-get install sox libsox-fmt-all",
    "  Windows native: winget install ChrisBagwell.SoX",
    "Note: when Pi runs inside WSL, the microphone must be available inside WSL/PulseAudio. Windows host hotkeys and host microphone capture are not automatically forwarded to WSL.",
  ].join("\n");
}

async function commandExists(command: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", () => resolve(true));
  });
}

async function resolveRecorder(audioPath: string): Promise<RecorderCommand> {
  if (await commandExists("rec")) {
    return {
      command: "rec",
      args: ["-q", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", audioPath],
      installHint: soxInstallHint(),
    };
  }

  if (await commandExists("sox")) {
    if (process.platform === "win32") {
      return {
        command: "sox",
        args: ["-q", "-t", "waveaudio", "default", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", audioPath],
        installHint: soxInstallHint(),
      };
    }

    return {
      command: "sox",
      args: ["-q", "-d", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", audioPath],
      installHint: soxInstallHint(),
    };
  }

  throw new RecorderError(soxInstallHint());
}

export async function startRecording(audioPath: string): Promise<RecordingSession> {
  const recorder = await resolveRecorder(audioPath);
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
        reject(new RecorderError(`Microphone recording failed to start${stderr ? `:\n${stderr.trim()}` : "."}\n${recorder.installHint}`));
      } else {
        resolve();
      }
    });
  });

  async function stopProcess(): Promise<void> {
    if (!closed) {
      child.kill("SIGINT");
      const forceKill = setTimeout(() => {
        if (!closed) child.kill("SIGTERM");
      }, 1500);
      await closePromise.finally(() => clearTimeout(forceKill));
    }
  }

  return {
    audioPath,
    stop: async () => {
      await stopProcess();
      if (processError) {
        throw new RecorderError(`Microphone recording failed: ${processError.message}`, processError);
      }
      if (closeCode !== null && closeCode !== 0 && closeCode !== 130) {
        throw new RecorderError(`Microphone recording failed${stderr ? `:\n${stderr.trim()}` : "."}`);
      }
      return audioPath;
    },
    abort: async () => {
      await stopProcess();
    },
  };
}
