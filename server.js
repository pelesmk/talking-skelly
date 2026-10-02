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
let turnGeneration = 0;
const voiceProcesses = new Set();
const voiceRequests = new Set();

const readConfig = async () => JSON.parse(await readFile(configPath, "utf8"));
const saveConfig = async (config) => writeFile(configPath, JSON.stringify(config, null, 2) + "\n");

function run(command, args, options = {}, tracked = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, ...options });
    if (tracked) voiceProcesses.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => (stdout += data));
    child.stderr?.on("data", (data) => (stderr += data));
    child.once("error", (error) => {
      voiceProcesses.delete(child);
      reject(error);
    });
    child.once("close", (code) => {
      voiceProcesses.delete(child);
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

const runVoice = (command, args, options = {}) => run(command, args, options, true);

function assertCurrentTurn(generation) {
  if (generation !== turnGeneration) {
    const error = new Error("Current turn was flushed.");
    error.code = "SKELLY_FLUSHED";
    throw error;
  }
}

async function requestReply(config, messages, generation) {
  const controller = new AbortController();
  voiceRequests.add(controller);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 90000);
  try {
    const response = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.ollamaModel,
        stream: false,
        think: false,
        keep_alive: "30m",
        messages,
        options: { temperature: 0.8, num_predict: 180 }
      })
    });
    assertCurrentTurn(generation);
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    return await response.json();
  } catch (error) {
    if (timedOut && generation === turnGeneration) throw new Error("Ollama took too long to answer.");
    throw error;
  } finally {
    clearTimeout(timeout);
    voiceRequests.delete(controller);
  }
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
  const generation = turnGeneration;
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
    const result = await runVoice("whisper-cli", ["-m", model, "-f", wav, "-nt", "-np"]);
    assertCurrentTurn(generation);
    const transcript = result.stdout.trim().replace(/^\[[^\]]+\]\s*/gm, "").trim();
    if (!transcript) throw new Error("I couldn't hear anything. Check the microphone selection and try again.");
    last.transcript = transcript;

    const nextHistory = [...history, { role: "user", content: transcript }].slice(-12);
    const data = await requestReply(config, [{ role: "system", content: config.systemPrompt }, ...nextHistory], generation);
    assertCurrentTurn(generation);
    const reply = data.message?.content?.trim();
    if (!reply) throw new Error("Ollama returned an empty response.");
    last.reply = reply;
    await speak(reply, config, generation);
    history = [...nextHistory, { role: "assistant", content: reply }].slice(-12);
  } catch (error) {
    assertCurrentTurn(generation);
    throw error;
  } finally {
    busy = false;
  }
}

async function captureAutomaticTurn(generation) {
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
      if (recorder === child) recorder = null;
      clearTimeout(timeout);
      if (!finished) {
        finished = true;
        if (generation !== turnGeneration || !code) resolveTurn(null);
        else reject(new Error(captureError.trim() || `Recorder exited with ${code}`));
      }
    });
  });
}

async function answerRecordedTurn(generation) {
  busy = true;
  last.error = "";
  try {
    const config = await readConfig();
    const wav = join(runtime, "visitor.wav");
    const model = resolve(root, config.whisperModel);
    await access(model);
    const result = await runVoice("whisper-cli", ["-m", model, "-f", wav, "-nt", "-np"]);
    assertCurrentTurn(generation);
    const transcript = result.stdout.trim().replace(/^\[[^\]]+\]\s*/gm, "").trim();
    if (!transcript || /^\s*\[(silence|blank audio)\]\s*$/i.test(transcript)) return;
    last.transcript = transcript;
    const nextHistory = [...history, { role: "user", content: transcript }].slice(-12);
    const data = await requestReply(config, [{ role: "system", content: config.systemPrompt }, ...nextHistory], generation);
    assertCurrentTurn(generation);
    const reply = data.message?.content?.trim();
    if (!reply) throw new Error("Ollama returned an empty response.");
    last.reply = reply;
    await speak(reply, config, generation);
    history = [...nextHistory, { role: "assistant", content: reply }].slice(-12);
  } finally { busy = false; }
}

async function conversationLoop() {
  while (conversation) {
    const generation = turnGeneration;
    try {
      const captured = await captureAutomaticTurn(generation);
      recorder = null;
      if (conversation && captured !== null && generation === turnGeneration) await answerRecordedTurn(generation);
    } catch (error) {
      if (generation !== turnGeneration || error.code === "SKELLY_FLUSHED") continue;
      last.error = error.message;
      conversation = false;
    }
  }
}

function stopConversation() {
  conversation = false;
  if (recorder?.stdin?.writable) recorder.stdin.write("q\n");
}

function flushCurrentTurn() {
  turnGeneration += 1;
  last.error = "";
  if (recorder) {
    const current = recorder;
    recorder = null;
    if (current.stdin?.writable) current.stdin.write("q\n");
    else current.kill("SIGTERM");
  }
  for (const controller of voiceRequests) controller.abort();
  for (const process of voiceProcesses) process.kill("SIGTERM");
  busy = false;
  return { ok: true, listening: conversation };
}

async function speak(text, config, generation = turnGeneration) {
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
  try {
    const raw = join(runtime, "voice.aiff");
    const processed = join(runtime, "skelly.wav");
    await runVoice("say", ["-v", config.voice, "-r", String(config.voiceRate), "-o", raw, clean]);
    assertCurrentTurn(generation);
    const probe = await runVoice("ffprobe", [
      "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate",
      "-of", "default=nw=1:nk=1", raw
    ]);
    assertCurrentTurn(generation);
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
    await runVoice("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", raw, "-af", effects, processed]);
    assertCurrentTurn(generation);
    await runVoice("afplay", [processed]);
    assertCurrentTurn(generation);
  } catch (error) {
    assertCurrentTurn(generation);
    throw error;
  }
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
    if (request.method === "POST" && url.pathname === "/api/conversation/flush") {
      return send(response, 200, flushCurrentTurn());
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
    if (error.code === "SKELLY_FLUSHED") {
      return send(response, 200, { ok: true, flushed: true });
    }
    last.error = error.message;
    send(response, 500, { error: error.message });
  }
});

server.listen(4317, "127.0.0.1", () => console.log("Talking Skelly: http://127.0.0.1:4317"));
