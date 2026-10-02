# Talking Skelly

A local, automatic voice-chat Halloween character for macOS:

`microphone → whisper.cpp → Ollama → custom voice effects → Skelly`

Whisper recognizes speech. Ollama writes the response. The included voice engine uses a macOS voice plus adjustable pitch, echo, speed, and volume. It can later be replaced by a neural TTS or a consented voice-cloning engine.

## One-time setup

1. Install Whisper: `brew install whisper-cpp`
2. Download the English model: `mkdir -p models && curl -L -o models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`
3. In macOS Sound settings, select **12ft Skelly(Live)** as the output.
4. Start Ollama if it is not already running.

## Run

```sh
npm start
```

Open <http://127.0.0.1:4317> and click **Start voice chat** once. Skelly automatically detects when a visitor speaks and when they finish, answers, and resumes listening.

## Mac app

Build the native launcher with:

```sh
npm run build:mac
```

Then open `dist/Talking Skelly.app`. It starts the server, opens the control panel in its own window, and enables hands-free listening automatically. The app can be copied into the Applications folder or dragged into the Dock.

On first recording, macOS may ask for microphone permission for Terminal or Codex. Allow it. Use **Find microphone number** in the app to identify the desired input.

## Avoiding feedback

The app uses automatic half-duplex turn-taking: it listens to the visitor, stops listening while Skelly speaks, then resumes. Keep the Bluetooth microphone several feet from Skelly's speaker for the cleanest detection.
