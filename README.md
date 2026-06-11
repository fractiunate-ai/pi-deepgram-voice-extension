# pi-deepgram-voice-extension

Native Pi TUI extension for Deepgram voice input. The extension runs inside the active Pi TUI process, records a short push-to-talk audio file, transcribes it with Deepgram, and submits the transcript with `pi.sendUserMessage()` so it behaves like text you typed into Pi yourself.

This project intentionally does **not** use `yukukotani/pi-voice`, does **not** run a separate daemon, and does **not** include TTS or live streaming.

## Commands and hotkey

```text
/voice          Start voice recording
/voicesettings  Select the microphone input used by /voice
Alt+J           Start/stop voice recording
Enter/Escape    Stop an active recording
```

Additional settings helpers:

```text
/voicesettings show   Show the selected microphone
/voicesettings reset  Reset to the system default microphone
```

## What it does

- Registers `/voice`
- Registers `/voicesettings`
- Registers the `Alt+J` TUI shortcut
- Shows a Pi TUI status/widget while recording or transcribing
- Records microphone audio to a temporary WAV file using SoX
- Stops recording when you press `Enter`, `Escape`, or `Alt+J` again
- Sends the prerecorded file to Deepgram speech-to-text
- Sends the transcript into Pi as a normal user message
- Removes temporary audio after transcription or error handling

## Requirements

### Deepgram API key

Set the API key before launching Pi:

```bash
export DEEPGRAM_API_KEY="..."
```

Optional Deepgram settings:

```bash
export DEEPGRAM_MODEL="nova-3"
export DEEPGRAM_LANGUAGE="en-US"
```

Defaults:

- `DEEPGRAM_MODEL`: `nova-3`
- `DEEPGRAM_LANGUAGE`: `en-US`

### Local audio recording dependency

Install SoX. On Linux/WSL, `pulseaudio-utils` and `alsa-utils` are recommended so `/voicesettings` can discover inputs.

```bash
# macOS
brew install sox

# Debian/Ubuntu/WSL
sudo apt-get update
sudo apt-get install -y sox libsox-fmt-all pulseaudio-utils alsa-utils

# Windows native
winget install ChrisBagwell.SoX
```

## WSL notes

When Pi runs inside WSL, this extension also runs inside WSL. Microphone devices are whatever WSL exposes to Linux audio tools.

Commonly, Windows audio input appears as a PulseAudio source such as:

```text
RDPSource (pulse: RDPSource)
```

Select it with:

```text
/voicesettings
```

If you switch microphones in Windows, WSL may still show the same redirected source name. In that case, choose the desired input device in Windows sound settings, then keep using the WSL-exposed source in Pi.

## Installation from local clone

```bash
git clone https://github.com/fractiunate-ai/pi-deepgram-voice-extension.git
cd pi-deepgram-voice-extension
bun install
```

## Installation via Pi extension path

Clone or copy this repo to Pi's global extension directory:

```bash
~/.pi/agent/extensions/pi-deepgram-voice-extension/
```

Install dependencies there:

```bash
cd ~/.pi/agent/extensions/pi-deepgram-voice-extension
bun install
```

Start or reload Pi:

```bash
pi
```

Inside Pi:

```text
/reload
```

## Test with `pi -e`

From the repo root:

```bash
export DEEPGRAM_API_KEY="..."
bun install
pi -e ./src/index.ts
```

Inside the Pi TUI:

```text
/voicesettings
/voice
```

or press:

```text
Alt+J
```

## Usage

1. Optional: run `/voicesettings` and select the microphone input.
2. Trigger `/voice` or press `Alt+J`.
3. Speak while the widget says recording is active.
4. Press `Enter`, `Escape`, or `Alt+J` again to stop.
5. The extension transcribes the temporary WAV file with Deepgram.
6. The transcript is sent into Pi as a user message.

## Limitations

- This initial version uses prerecorded push-to-talk transcription, not live streaming.
- It depends on SoX and the microphone devices visible to the Pi process.
- In WSL, device names may be virtual/redirected rather than the physical microphone name.

## Security note

Recorded audio is sent to Deepgram for transcription. Do not use this extension for audio you do not want sent to Deepgram.

## Development

```bash
bun install
bun run typecheck
pi -e ./src/index.ts
```
