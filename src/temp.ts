import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface TempAudioFile {
  dir: string;
  path: string;
  rawPath: string;
  cleanup: () => Promise<void>;
}

export async function createTempAudioFile(): Promise<TempAudioFile> {
  const dir = await mkdtemp(join(tmpdir(), "pi-deepgram-voice-"));

  return {
    dir,
    path: join(dir, "recording.wav"),
    rawPath: join(dir, "recording.raw"),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
