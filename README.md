# Talking Skelly

A local, automatic voice-chat Halloween character for macOS:

`microphone → whisper.cpp → Ollama → custom voice effects → Skelly`

Whisper recognizes speech. Ollama writes the response. The included voice engine uses a macOS voice plus adjustable pitch, echo, speed, and volume. It can later be replaced by a neural TTS or a consented voice-cloning engine.

## One-time setup

1. Install Whisper: `brew install whisper-cpp`
2. Download the English model: `mkdir -p models && curl -L -o models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`
3. Start Ollama if it is not already running.

## Connect Skelly and the remote microphone

Skelly's Live Bluetooth connection is hidden until it is enabled through the phone app. Complete these steps before launching Talking Skelly:

1. Power on Skelly.
2. On your phone, open the **DecorPro SVI** app and connect to Skelly.
3. Open **Customize** and tap **Live**. This makes **Skelly (Live)** discoverable over Bluetooth.
4. On the Mac hosting Talking Skelly, open **System Settings → Bluetooth** and connect to **Skelly (Live)**. The device may appear as **12ft Skelly (Live)** or a similar name.
5. If macOS requests a Bluetooth PIN, enter **1234**.
6. Open **System Settings → Sound → Input** and select the remote microphone positioned near Skelly. Our deployment uses **EMEET OfficeCore M0 Plus**, hidden in a nearby bush.
7. Under **System Settings → Sound → Output**, select **Skelly (Live)**. Talking Skelly's generated voice will play through Skelly's internal speaker and move its jaw.
8. Launch **Talking Skelly.app**. It starts the local server and enables hands-free listening automatically.

If the microphone is not detected correctly, open **Find microphone number** in the Talking Skelly control panel and select the input that corresponds to the remote microphone.

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

On first recording, macOS may ask for microphone permission for Talking Skelly, Terminal, or Codex. Allow it.

## Avoiding feedback

The app uses automatic half-duplex turn-taking: it listens to the visitor, stops listening while Skelly speaks, then resumes. Keep the Bluetooth microphone several feet from Skelly's speaker for the cleanest detection.

## License

MIT
