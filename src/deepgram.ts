import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { DeepgramClient } from "@deepgram/sdk";
import { loadVoiceSettings } from "./settings.js";

export class DeepgramTranscriptionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "DeepgramTranscriptionError";
  }
}

export interface LiveTranscriptionSession {
  sendAudio: (chunk: Buffer) => void;
  finalize: () => Promise<string>;
  close: () => void;
}

interface TranscriptState {
  finalSegments: string[];
  interim: string;
}

const LIVE_FINALIZE_TIMEOUT_MS = 2500;

export async function transcribeFile(audioPath: string, options: { rawLinear16?: boolean } = {}): Promise<string> {
  const apiKey = getApiKey();
  const settings = await loadVoiceSettings();

  const fileStats = await stat(audioPath);
  if (fileStats.size < 1024) {
    throw new DeepgramTranscriptionError("Recorded audio file is empty or too short. Check microphone input and try again.");
  }

  const client = new DeepgramClient({ apiKey });

  let result: unknown;
  try {
    result = await client.listen.v1.media.transcribeFile(createReadStream(audioPath), {
      model: process.env.DEEPGRAM_MODEL ?? settings.model,
      language: process.env.DEEPGRAM_LANGUAGE ?? settings.language,
      ...(options.rawLinear16 ? { encoding: "linear16", sample_rate: 16000, channels: 1 } : {}),
      smart_format: true,
      punctuate: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DeepgramTranscriptionError(`Deepgram transcription failed: ${message}`, error);
  }

  const transcript = extractPrerecordedTranscript(result).trim();
  if (!transcript) {
    throw new DeepgramTranscriptionError("Deepgram returned an empty transcript. Try recording again closer to the microphone.");
  }

  return transcript;
}

export async function startLiveTranscription(onTranscript: (transcript: string) => void): Promise<LiveTranscriptionSession> {
  const apiKey = getApiKey();
  const settings = await loadVoiceSettings();
  const client = new DeepgramClient({ apiKey });
  const state: TranscriptState = { finalSegments: [], interim: "" };
  let finalized = false;
  let closed = false;
  let lastError: Error | undefined;
  let resolveFinal: ((transcript: string) => void) | undefined;
  let rejectFinal: ((error: Error) => void) | undefined;

  const connection = await client.listen.v1.connect({
    model: process.env.DEEPGRAM_MODEL ?? settings.model,
    language: process.env.DEEPGRAM_LANGUAGE ?? settings.language,
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
    smart_format: "true",
    punctuate: "true",
    interim_results: "true",
    endpointing: process.env.DEEPGRAM_ENDPOINTING ?? "300",
  } as never);

  connection.on("message", (message) => {
    if (message.type !== "Results") return;
    const transcript = message.channel.alternatives[0]?.transcript?.trim() ?? "";
    if (!transcript) return;

    if (message.is_final) {
      state.finalSegments.push(transcript);
      state.interim = "";
    } else {
      state.interim = transcript;
    }

    onTranscript(currentTranscript(state));

    if (message.from_finalize && resolveFinal) {
      resolveFinal(currentTranscript(state));
    }
  });

  connection.on("error", (error) => {
    lastError = error;
    rejectFinal?.(new DeepgramTranscriptionError(`Deepgram live transcription failed: ${error.message}`, error));
  });

  connection.on("close", () => {
    closed = true;
    if (finalized && resolveFinal) resolveFinal(currentTranscript(state));
  });

  try {
    connection.connect();
    await connection.waitForOpen();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DeepgramTranscriptionError(`Deepgram live connection failed: ${message}`, error);
  }

  return {
    sendAudio: (chunk) => {
      if (closed || lastError) return;
      try {
        connection.sendMedia(chunk);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = new DeepgramTranscriptionError(`Deepgram live audio send failed: ${message}`, error);
      }
    },
    finalize: async () => {
      if (lastError) throw lastError;
      finalized = true;
      const finalTranscriptPromise = new Promise<string>((resolve, reject) => {
        resolveFinal = resolve;
        rejectFinal = reject;
      });

      try {
        connection.sendFinalize({ type: "Finalize" });
      } catch {
        // Some sessions may already have finalized/closed; use the best transcript collected so far.
      }

      const transcript = await withTimeout(finalTranscriptPromise, LIVE_FINALIZE_TIMEOUT_MS, currentTranscript(state));
      connection.close();
      const cleaned = transcript.trim();
      if (!cleaned) {
        throw new DeepgramTranscriptionError("Deepgram returned an empty live transcript. Try recording again closer to the microphone.");
      }
      return cleaned;
    },
    close: () => {
      connection.close();
    },
  };
}

function getApiKey(): string {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new DeepgramTranscriptionError(
      "DEEPGRAM_API_KEY is missing. Set it before launching Pi, e.g. `export DEEPGRAM_API_KEY=\"...\"`.",
    );
  }
  return apiKey;
}

function currentTranscript(state: TranscriptState): string {
  return [...state.finalSegments, state.interim].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function extractPrerecordedTranscript(result: unknown): string {
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

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
