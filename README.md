# pi-deepgram-voice-extension

Native Pi TUI extension for Deepgram voice input. It runs inside the active Pi TUI process and sends the transcript as a normal user message, as if you typed it yourself.

This project intentionally does **not** use `yukukotani/pi-voice`, does **not** run a companion daemon, and does **not** add TTS or live streaming yet.

## What it does

- Registers `/voice`
- Registers `alt+j`
- Shows a Pi TUI status/widget while recording
- Records microphone audio to a temporary WAV file using SoX/`rec`
- Stops when you press `Enter`, `Escape`, or `alt+j` again
- Sends the prerecorded file to Deepgram for speech-to-text
- Sends the transcript with `pi.sendUserMessage()` so it behaves like typed input
- Clears the status/widget afterward

## Requirements

### Deepgram API key

```bash
export DEEPGRAM_API_KEY="..."
```

Optional:

```bash
export DEEPGRAM_MODEL="nova-3"
export DEEPGRAM_LANGUAGE="en-US"
```

### Local recorder dependency

Install SoX so the `rec` command is available:

```bash
# macOS
brew install sox

# Debian/Ubuntu/WSL
sudo apt-get update && sudo apt-get install -y sox libsox-fmt-all

# Windows native
winget install ChrisBagwell.SoX
```

## WSL and Windows hotkey note

Pi TUI extensions run inside the Pi process. If Pi is running in WSL, the extension runs in WSL too.

That means:

- Windows global hotkeys like `Win+J` are not delivered directly to a terminal app inside WSL.
- Use Pi's in-terminal shortcut `alt+j`, or map `Win+J` on the Windows host to send `Alt+J` to Windows Terminal/WezTerm/etc.
- Microphone recording must be available inside WSL. If SoX cannot access your mic, either configure WSL/PulseAudio microphone input or run Pi natively on the host OS.

Example AutoHotkey v2 mapping on Windows:

```ahk
#j::Send "!j"
```

## Installation from local clone

```bash
git clone https://github.com/fractiunate-ai/pi-deepgram-voice-extension.git
cd pi-deepgram-voice-extension
bun install
```

Then either run with `pi -e` for testing, or place/clone it in Pi's global extension directory.

## Installation via Pi extension path

Clone or copy this repo to:

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
# then inside Pi:
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
/voice
```

or press:

```text
alt+j
```

## Usage

1. Trigger `/voice` or `alt+j`.
2. Speak while the widget says recording is active.
3. Press `Enter`, `Escape`, or `alt+j` again to stop.
4. The extension transcribes with Deepgram and sends the transcript into Pi as a user message.

## Limitation

This initial version uses prerecorded push-to-talk transcription. It does **not** use Deepgram live streaming yet.

## Security note

Your recorded audio is sent to Deepgram for transcription. Do not use this extension for audio you do not want sent to Deepgram.

## Development

```bash
bun install
bun run typecheck
pi -e ./src/index.ts
```

Planned branch:

```bash
git checkout -b feature/deepgram-voice-extension
```

Suggested commit message:

```bash
git commit -m "Add Deepgram voice input extension"
```
