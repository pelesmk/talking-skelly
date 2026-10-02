import { createServer } from "node:http";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const runtime = join(root, ".runtime");
const configPath = join(root, "config.json");
await mkdir(runtime, { recursive: true });

let recorder = null;
let busy = false;
let conversation = false;
let history = [];
let last = { transcript: "", reply: "", error: "" };

const readConfig = async () => JSON.parse(await readFile(configPath, "utf8"));
const saveConfig = async (config) => writeFile(configPath, JSON.stringify(config, null, 2) + "\n");

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => (stdout += data));
    child.stderr?.on("data", (data) => (stderr += data));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

async function commandExists(command) {
  try {
    await run("/usr/bin/which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function status() {
  const config = await readConfig();
  let ollama = false;
  try {
    const response = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
    ollama = response.ok;
  } catch {}
  return {
    recording: Boolean(recorder),
    conversation,
    busy,
    ollama,
    whisper: await commandExists("whisper-cli"),
    config,
    ...last
  };
}

async function listAudioDevices() {
  try {
    const result = await run("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]);
    return result.stderr;
  } catch (error) {
    return error.message;
  }
}

async function listVoices() {
  const { stdout } = await run("say", ["-v", "?"]);
  return stdout.split("\n").map((line) => {
    const match = line.match(/^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})\s+#\s*(.*)$/);
    return match ? { name: match[1].trim(), locale: match[2], sample: match[3].trim() } : null;
  }).filter(Boolean);
}

async function listModels() {
  const config = await readConfig();
  const response = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  const data = await response.json();
  return (data.models || []).map((model) => ({
    name: model.name,
    size: model.size || 0,
    parameters: model.details?.parameter_size || ""
  }));
}

async function startRecording() {
  if (recorder || busy) throw new Error("Skelly is already recording or thinking.");
  const config = await readConfig();
  const wav = join(runtime, "visitor.wav");
  recorder = spawn("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-f", "avfoundation",
    "-i", `:${config.microphoneIndex}`, "-ac", "1", "-ar", "16000",
    "-c:a", "pcm_s16le", wav
  ], { cwd: root, stdio: ["pipe", "ignore", "pipe"] });
  let captureError = "";
  recorder.stderr.on("data", (data) => (captureError += data));
  recorder.once("exit", (code) => {
    if (code && code !== 255) last.error = captureError.trim() || `Recorder exited with ${code}`;
    recorder = null;
  });
}

async function stopRecordingAndAnswer() {
  if (!recorder) throw new Error("Recording has not started.");
  const current = recorder;
  await new Promise((resolveStop) => {
    current.once("exit", resolveStop);
    current.stdin.write("q\n");
  });
  recorder = null;
  busy = true;
  last.error = "";
  try {
    const config = await readConfig();
    const wav = join(runtime, "visitor.wav");
    const model = resolve(root, config.whisperModel);
    await access(model);
    const result = await run("whisper-cli", ["-m", model, "-f", wav, "-nt", "-np"]);
    const transcript = result.stdout.trim().replace(/^\[[^\]]+\]\s*/gm, "").trim();
    if (!transcript) throw new Error("I couldn't hear anything. Check the microphone selection and try again.");
    last.transcript = transcript;

    history.push({ role: "user", content: transcript });
    history = history.slice(-12);
    const response = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify({
        model: config.ollamaModel,
        stream: false,
        think: false,
        keep_alive: "30m",
        messages: [{ role: "system", content: config.systemPrompt }, ...history],
        options: { temperature: 0.8, num_predict: 180 }
      })
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const data = await response.json();
    const reply = data.message?.content?.trim();
    if (!reply) throw new Error("Ollama returned an empty response.");
    last.reply = reply;
    history.push({ role: "assistant", content: reply });
    await speak(reply, config);
  } finally {
    busy = false;
  }
}

async function captureAutomaticTurn() {
  const config = await readConfig();
  const wav = join(runtime, "visitor.wav");
  return new Promise((resolveTurn, reject) => {
    let heardSpeech = false;
    let finished = false;
    let captureError = "";
    const child = spawn("ffmpeg", [
      "-y", "-hide_banner", "-f", "avfoundation", "-i", `:${config.microphoneIndex}`,
      "-ac", "1", "-ar", "16000", "-af", "silencedetect=noise=-38dB:d=1.1",
      "-c:a", "pcm_s16le", wav
    ], { cwd: root, stdio: ["pipe", "ignore", "pipe"] });
    recorder = child;
    const timeout = setTimeout(() => stop(false), 45000);
    function stop(success) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      child.stdin.write("q\n");
      child.once("exit", () => success ? resolveTurn() : resolveTurn(null));
    }
    child.stderr.on("data", (data) => {
      const text = String(data);
      captureError += text;
      if (text.includes("silence_end:")) heardSpeech = true;
      if (heardSpeech && text.includes("silence_start:")) stop(true);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      recorder = null;
      clearTimeout(timeout);
      if (!finished && code) reject(new Error(captureError.trim() || `Recorder exited with ${code}`));
    });
  });
}

async function answerRecordedTurn() {
  busy = true;
  last.error = "";
  try {
    const config = await readConfig();
    const wav = join(runtime, "visitor.wav");
    const model = resolve(root, config.whisperModel);
    await access(model);
    const result = await run("whisper-cli", ["-m", model, "-f", wav, "-nt", "-np"]);
    const transcript = result.stdout.trim().replace(/^\[[^\]]+\]\s*/gm, "").trim();
    if (!transcript || /^\s*\[(silence|blank audio)\]\s*$/i.test(transcript)) return;
    last.transcript = transcript;
    history.push({ role: "user", content: transcript });
    history = history.slice(-12);
    const response = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(90000),
      body: JSON.stringify({ model: config.ollamaModel, stream: false, think: false, keep_alive: "30m",
        messages: [{ role: "system", content: config.systemPrompt }, ...history],
        options: { temperature: 0.8, num_predict: 180 } })
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const data = await response.json();
    const reply = data.message?.content?.trim();
    if (!reply) throw new Error("Ollama returned an empty response.");
    last.reply = reply;
    history.push({ role: "assistant", content: reply });
    await speak(reply, config);
  } finally { busy = false; }
}

async function conversationLoop() {
  while (conversation) {
    try {
      const captured = await captureAutomaticTurn();
      recorder = null;
      if (conversation && captured !== null) await answerRecordedTurn();
    } catch (error) {
      last.error = error.message;
      conversation = false;
    }
  }
}

function stopConversation() {
  conversation = false;
  if (recorder?.stdin?.writable) recorder.stdin.write("q\n");
}

async function speak(text, config) {
  const clean = text
    .replace(/\*[^*]+\*/g, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/[`*_#>~]/g, "")
    .replace(/[“”"]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  if (!clean) throw new Error("Skelly's reply contained no speakable text.");
  const raw = join(runtime, "voice.aiff");
  const processed = join(runtime, "skelly.wav");
  await run("say", ["-v", config.voice, "-r", String(config.voiceRate), "-o", raw, clean]);
  const probe = await run("ffprobe", [
    "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate",
    "-of", "default=nw=1:nk=1", raw
  ]);
  const sampleRate = Number.parseInt(probe.stdout.trim(), 10) || 22050;
  const factor = Math.pow(2, Number(config.pitchSemitones) / 12);
  const tempo = Math.max(0.5, Math.min(2, 1 / factor));
  const echo = Math.max(0, Math.min(0.75, Number(config.echo)));
  const volume = Math.max(0.1, Math.min(3, Number(config.volume)));
  const effects = [
    `asetrate=${Math.round(sampleRate * factor)}`,
    `aresample=${sampleRate}`,
    `atempo=${tempo.toFixed(5)}`,
    echo ? `aecho=0.8:0.75:85|170:${echo.toFixed(2)}|${(echo / 2).toFixed(2)}` : null,
    `volume=${volume}`,
    "alimiter=limit=0.95"
  ].filter(Boolean).join(",");
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", raw, "-af", effects, processed]);
  await run("afplay", [processed]);
}

async function jsonBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

function send(response, code, value, type = "application/json") {
  response.writeHead(code, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
  response.end(type === "application/json" ? JSON.stringify(value) : value);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/") {
      return send(response, 200, await readFile(join(root, "web", "index.html"), "utf8"), "text/html");
    }
    if (request.method === "GET" && url.pathname === "/api/status") return send(response, 200, await status());
    if (request.method === "GET" && url.pathname === "/api/devices") return send(response, 200, { text: await listAudioDevices() });
    if (request.method === "GET" && url.pathname === "/api/voices") return send(response, 200, { voices: await listVoices() });
    if (request.method === "GET" && url.pathname === "/api/models") return send(response, 200, { models: await listModels() });
    if (request.method === "POST" && url.pathname === "/api/record/start") {
      await startRecording();
      return send(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/record/stop") {
      await stopRecordingAndAnswer();
      return send(response, 200, { ok: true, ...last });
    }
    if (request.method === "POST" && url.pathname === "/api/conversation/start") {
      if (conversation) {
        last.error = "";
        return send(response, 200, { ok: true, alreadyActive: true });
      }
      if (busy || recorder) throw new Error("Skelly is finishing the current turn. Try again in a moment.");
      conversation = true;
      last.error = "";
      conversationLoop();
      return send(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/conversation/stop") {
      stopConversation();
      return send(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/speak") {
      const { text } = await jsonBody(request);
      await speak(String(text || "Skelly is awake."), await readConfig());
      return send(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/config") {
      const current = await readConfig();
      const update = await jsonBody(request);
      const allowed = ["ollamaModel", "microphoneIndex", "voiceRate", "pitchSemitones", "systemPrompt"];
      for (const key of allowed) if (key in update) current[key] = update[key];
      current.voice = "Daniel";
      current.echo = 0.06;
      current.volume = 1.5;
      await saveConfig(current);
      return send(response, 200, { ok: true, config: current });
    }
    send(response, 404, { error: "Not found" });
  } catch (error) {
    last.error = error.message;
    send(response, 500, { error: error.message });
  }
});

server.listen(4317, "127.0.0.1", () => console.log("Talking Skelly: http://127.0.0.1:4317"));
