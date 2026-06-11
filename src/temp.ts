import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface TempAudioFile {
  dir: string;
  path: string;
  cleanup: () => Promise<void>;
}

export async function createTempAudioFile(): Promise<TempAudioFile> {
  const dir = await mkdtemp(join(tmpdir(), "pi-deepgram-voice-"));
  const path = join(dir, "recording.wav");

  return {
    dir,
    path,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
