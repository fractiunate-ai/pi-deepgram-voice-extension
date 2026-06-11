import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AudioInputDevice =
  | { kind: "default"; id: "default"; label: string }
  | { kind: "pulse"; id: string; label: string }
  | { kind: "alsa"; id: string; label: string };

export interface VoiceSettings {
  device: AudioInputDevice;
}

const DEFAULT_DEVICE: AudioInputDevice = {
  kind: "default",
  id: "default",
  label: "System default microphone",
};

const SETTINGS_PATH = join(homedir(), ".config", "pi-deepgram-voice-extension", "settings.json");

export function defaultVoiceSettings(): VoiceSettings {
  return { device: DEFAULT_DEVICE };
}

export async function loadVoiceSettings(): Promise<VoiceSettings> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<VoiceSettings>;
    if (isAudioInputDevice(parsed.device)) {
      return { device: parsed.device };
    }
  } catch {
    // Missing or invalid settings fall back to default.
  }
  return defaultVoiceSettings();
}

export async function saveVoiceSettings(settings: VoiceSettings): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

export function formatDevice(device: AudioInputDevice): string {
  if (device.kind === "default") return device.label;
  return `${device.label} (${device.kind}: ${device.id})`;
}

export async function listAudioInputDevices(): Promise<AudioInputDevice[]> {
  const devices: AudioInputDevice[] = [DEFAULT_DEVICE];
  devices.push(...await listPulseSources());
  devices.push(...await listAlsaDevices());
  return dedupeDevices(devices);
}

async function listPulseSources(): Promise<AudioInputDevice[]> {
  const result = await execFileSafe("pactl", ["list", "short", "sources"]);
  if (!result.ok) return [];

  const descriptions = await getPulseSourceDescriptions();

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): AudioInputDevice | undefined => {
      const fields = line.split(/\s+/);
      const id = fields[1];
      if (!id || id.includes(".monitor")) return undefined;
      return { kind: "pulse", id, label: descriptions.get(id) ?? id };
    })
    .filter((device): device is AudioInputDevice => device !== undefined);
}

async function getPulseSourceDescriptions(): Promise<Map<string, string>> {
  const result = await execFileSafe("pactl", ["list", "sources"]);
  const descriptions = new Map<string, string>();
  if (!result.ok) return descriptions;

  let currentName: string | undefined;
  for (const rawLine of result.stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("Name:")) {
      currentName = line.slice("Name:".length).trim();
      continue;
    }
    if (currentName && line.startsWith("Description:")) {
      descriptions.set(currentName, line.slice("Description:".length).trim());
      currentName = undefined;
    }
  }
  return descriptions;
}

async function listAlsaDevices(): Promise<AudioInputDevice[]> {
  const result = await execFileSafe("arecord", ["-L"]);
  if (!result.ok) return [];

  const devices: AudioInputDevice[] = [];
  const lines = result.stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const id = lines[i]?.trim();
    if (!id || id.startsWith("#") || id === "null" || id === "default") continue;
    const isDeviceLine = lines[i] === id;
    if (!isDeviceLine) continue;
    const description = lines[i + 1]?.trim();
    devices.push({ kind: "alsa", id, label: description ? `${description}` : id });
  }
  return devices;
}

function dedupeDevices(devices: AudioInputDevice[]): AudioInputDevice[] {
  const seen = new Set<string>();
  return devices.filter((device) => {
    const key = `${device.kind}:${device.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isAudioInputDevice(value: unknown): value is AudioInputDevice {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AudioInputDevice>;
  return (
    typeof candidate.kind === "string" &&
    ["default", "pulse", "alsa"].includes(candidate.kind) &&
    typeof candidate.id === "string" &&
    typeof candidate.label === "string"
  );
}

function execFileSafe(command: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: unknown }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.once("error", (error) => resolve({ ok: false, error }));
    child.once("close", (code) => {
      if (code === 0) resolve({ ok: true, stdout });
      else resolve({ ok: false, error: new Error(`${command} exited with ${code}`) });
    });
  });
}
