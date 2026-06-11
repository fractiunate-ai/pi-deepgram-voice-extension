import { createReadStream } from "node:fs";
import { DeepgramClient } from "@deepgram/sdk";

export class DeepgramTranscriptionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "DeepgramTranscriptionError";
  }
}

export async function transcribeFile(audioPath: string): Promise<string> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new DeepgramTranscriptionError(
      "DEEPGRAM_API_KEY is missing. Set it before launching Pi, e.g. `export DEEPGRAM_API_KEY=\"...\"`.",
    );
  }

  const client = new DeepgramClient({ apiKey });

  let result: unknown;
  try {
    result = await client.listen.v1.media.transcribeFile(createReadStream(audioPath), {
      model: process.env.DEEPGRAM_MODEL ?? "nova-3",
      language: process.env.DEEPGRAM_LANGUAGE ?? "en-US",
      smart_format: true,
      punctuate: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DeepgramTranscriptionError(`Deepgram transcription failed: ${message}`, error);
  }

  const transcript = extractTranscript(result).trim();
  if (!transcript) {
    throw new DeepgramTranscriptionError("Deepgram returned an empty transcript. Try recording again closer to the microphone.");
  }

  return transcript;
}

function extractTranscript(result: unknown): string {
  const response = result as {
    results?: {
      channels?: Array<{
        alternatives?: Array<{
          transcript?: unknown;
        }>;
      }>;
    };
  };

  const transcript = response.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  return typeof transcript === "string" ? transcript : "";
}
