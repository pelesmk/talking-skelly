import { createServer } from "node:http";
import { readFile, writeFile, mkdir, access, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { hostname, networkInterfaces } from "node:os";

const root = dirname(fileURLToPath(import.meta.url));
const runtime = join(root, ".runtime");
const configPath = join(root, "config.json");
const piTokenPath = join(runtime, "pi-token");
await mkdir(runtime, { recursive: true });

async function loadOrCreatePiToken() {
  try {
    return (await readFile(piTokenPath, "utf8")).trim();
  } catch {
    const token = randomBytes(24).toString("hex");
    await writeFile(piTokenPath, `${token}\n`, { mode: 0o600 });
    return token;
  }
}

const piToken = await loadOrCreatePiToken();

let recorder = null;
let busy = false;
let conversation = false;
let history = [];
let last = { transcript: "", reply: "", error: "" };
let turnGeneration = 0;
const voiceProcesses = new Set();
const voiceRequests = new Set();
let remoteState = { state: "offline", detail: "", lastSeen: 0, client: "" };

const readConfig = async () => JSON.parse(await readFile(configPath, "utf8"));
const saveConfig = async (config) => writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
const startupConfig = await readConfig();
const deploymentMode = process.env.SKELLY_DEPLOYMENT_MODE || startupConfig.deploymentMode || "standalone";
const serverPort = Number(process.env.SKELLY_PORT || (deploymentMode === "pi" ? 4318 : 4317));

function run(command, args, options = {}, tracked = false) {
  return new Promise((resolveRun, reject) => {
    const { timeoutMs = 0, ...spawnOptions } = options;
    const child = spawn(command, args, { cwd: root, ...spawnOptions });
    if (tracked) voiceProcesses.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = timeoutMs ? setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs) : null;
    child.stdout?.on("data", (data) => (stdout += data));
    child.stderr?.on("data", (data) => (stderr += data));
    child.once("error", (error) => {
      if (timeout) clearTimeout(timeout);
      voiceProcesses.delete(child);
      reject(error);
    });
    child.once("close", (code) => {
      if (timeout) clearTimeout(timeout);
      voiceProcesses.delete(child);
      if (timedOut) reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
      else if (code === 0) resolveRun({ stdout, stderr });
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
        options: {
          temperature: 0.78,
          num_predict: 105,
          repeat_last_n: 256,
          repeat_penalty: 1.10
        }
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
    remote: {
      ...remoteState,
      connected: Date.now() - remoteState.lastSeen < 15000
    },
    config: { ...config, deploymentMode },
    ...last
  };
}

function piIsAuthorized(request) {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  const expected = Buffer.from(piToken);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isLoopback(request) {
  const address = request.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function localServerUrls(port) {
  const urls = new Set([`http://${hostname().replace(/\.local$/, "")}.local:${port}`]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) urls.add(`http://${entry.address}:${port}`);
    }
  }
  return [...urls];
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
  const wav = join(runtime, "visitor.wav");
  recorder = spawn("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-f", "avfoundation",
    "-i", ":default", "-ac", "1", "-ar", "16000",
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
    const wav = join(runtime, "visitor.wav");
    const turn = await processAudioTurn(wav, join(runtime, "skelly.wav"), generation, true, "local");
    if (!turn) throw new Error("I couldn't hear anything. Check the input selected in macOS Sound settings and try again.");
  } catch (error) {
    assertCurrentTurn(generation);
    throw error;
  } finally {
    busy = false;
  }
}

async function prepareAudioForTranscription(wav, prefix, generation, speechOffsetSeconds = 0) {
  const prepared = join(runtime, `${prefix}-clean-${generation}.wav`);
  const offset = Math.max(0, Math.min(45, Number(speechOffsetSeconds) || 0));
  await runVoice("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    ...(offset ? ["-ss", offset.toFixed(2)] : []),
    "-i", wav,
    "-af", "highpass=f=180,lowpass=f=7000,afftdn=nf=-28",
    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", prepared
  ], { timeoutMs: 15000 });
  assertCurrentTurn(generation);

  const probe = await runVoice("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1", prepared
  ], { timeoutMs: 5000 });
  assertCurrentTurn(generation);
  const duration = Number.parseFloat(probe.stdout.trim());
  if (!Number.isFinite(duration) || duration < 0.35) {
    await unlink(prepared).catch(() => {});
    return null;
  }

  const levels = await runVoice("ffmpeg", [
    "-hide_banner", "-nostats", "-i", prepared,
    "-af", "volumedetect", "-f", "null", "-"
  ], { timeoutMs: 5000 });
  assertCurrentTurn(generation);
  const meanVolume = Number.parseFloat(levels.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1]);
  const maxVolume = Number.parseFloat(levels.stderr.match(/max_volume:\s*(-?[\d.]+) dB/)?.[1]);
  if (!Number.isFinite(meanVolume) || !Number.isFinite(maxVolume) || meanVolume < -58 || maxVolume < -38) {
    await unlink(prepared).catch(() => {});
    return null;
  }
  return prepared;
}

async function processAudioTurn(wav, output, generation, playAudio, prefix, speechOffsetSeconds = 0) {
  const config = await readConfig();
  const model = resolve(root, config.whisperModel);
  await access(model);
  const prepared = await prepareAudioForTranscription(wav, prefix, generation, speechOffsetSeconds);
  if (!prepared) return null;
  let transcript = "";
  const whisperOutput = join(runtime, `${prefix}-whisper-${generation}`);
  const whisperJson = `${whisperOutput}.json`;
  try {
    // CPU Whisper is fast enough for these short turns and does not compete with
    // Ollama for Metal memory. No fallback bounds pathological noise-triggered work.
    const result = await runVoice("whisper-cli", [
      "--no-gpu", "-nf", "-sns", "-l", "en", "-nth", "0.50",
      "-m", model, "-f", prepared, "-nt", "-np", "-ojf", "-of", whisperOutput
    ], { timeoutMs: 45000 });
    assertCurrentTurn(generation);
    let report = null;
    try {
      report = JSON.parse(await readFile(whisperJson, "utf8"));
    } catch {}
    if (report?.transcription) {
      transcript = report.transcription.map((segment) => segment.text || "").join(" ").replace(/\s+/g, " ").trim();
      const wordProbabilities = report.transcription.flatMap((segment) => segment.tokens || [])
        .filter((token) => !String(token.text || "").startsWith("[_") && /[a-z0-9]/i.test(String(token.text || "")))
        .map((token) => Number(token.p))
        .filter(Number.isFinite);
      const confidence = wordProbabilities.length
        ? wordProbabilities.reduce((sum, value) => sum + value, 0) / wordProbabilities.length
        : 0;
      if (confidence < 0.58 || (wordProbabilities.length <= 2 && confidence < 0.76)) transcript = "";
    } else {
      transcript = result.stdout.trim().replace(/^\[[^\]]+\]\s*/gm, "").trim();
    }
  } finally {
    await unlink(prepared).catch(() => {});
    await unlink(whisperJson).catch(() => {});
  }
  if (!transcript || /^\s*\[(silence|blank audio)\]\s*$/i.test(transcript)) return null;

  last.transcript = transcript;
  const nextHistory = [...history, { role: "user", content: transcript }].slice(-12);
  const varietyPrompt = "Reply with two or three concise natural sentences, aiming for 55 to 65 spoken words and never exceeding 65 words. Ask no more than one question. Never repeat or rephrase an earlier question. If the visitor did not answer it, let it go. Give only Skelly's spoken response, with no drafts, notes, analysis, or alternatives.";
  const data = await requestReply(config, [
    { role: "system", content: `${config.systemPrompt}\n\n${varietyPrompt}` },
    ...nextHistory
  ], generation);
  assertCurrentTurn(generation);
  const reply = cleanReply(data.message?.content, history);
  if (!reply) throw new Error("Ollama returned an empty response.");

  last.reply = reply;
  await renderSpeech(reply, config, generation, output, prefix);
  if (playAudio) {
    await runVoice("afplay", [output]);
    assertCurrentTurn(generation);
  }
  history = [...nextHistory, { role: "assistant", content: reply }].slice(-12);
  return { transcript, reply, output };
}

const commonWords = new Set([
  "about", "after", "again", "also", "and", "are", "been", "before", "but", "can", "did", "does",
  "for", "from", "have", "how", "into", "just", "like", "more", "not", "now", "that", "the", "their",
  "them", "then", "there", "they", "this", "was", "were", "what", "when", "where", "which", "who", "will",
  "with", "would", "you", "your"
]);

function comparisonWords(text) {
  return (String(text || "").toLowerCase().match(/[a-z0-9']+/g) || [])
    .filter((word) => word.length > 2 && !commonWords.has(word));
}

function sentenceSimilarity(left, right) {
  const a = new Set(comparisonWords(left));
  const b = new Set(comparisonWords(right));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function cleanReply(raw, priorHistory) {
  if (!raw) return "";
  const safeLines = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^(?:\*?\(?\s*)?(?:note|analysis|revision|alternative|wait\b|actually\b|corrected response)/i.test(trimmed)) break;
    if (trimmed) safeLines.push(trimmed);
  }
  const candidate = safeLines.join(" ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[`*_#>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = candidate.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  const priorSentences = priorHistory
    .filter((message) => message.role === "assistant")
    .flatMap((message) => String(message.content || "").match(/[^.!?]+[.!?]+|[^.!?]+$/g) || []);
  const chosen = [];
  let questions = 0;
  let spokenWords = 0;
  const maxSpokenWords = 65;
  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim().replace(/^["']+|["']+$/g, "");
    if (!sentence || /(?:original prompt|inside character|breaking frame|language model|sentences? total|at most \w+ sentences?|no more than \w+ questions?)/i.test(sentence)) continue;
    const isQuestion = sentence.endsWith("?") || /^(?:do|does|did|are|is|can|could|would|will|what|where|when|who|why|how)\b/i.test(sentence);
    if (isQuestion && questions >= 1) continue;
    const repeated = priorSentences.some((prior) => sentenceSimilarity(sentence, prior) >= 0.72);
    if (repeated) continue;
    const sentenceWords = sentence.match(/[a-z0-9]+(?:['-][a-z0-9]+)*/gi) || [];
    if (spokenWords + sentenceWords.length > maxSpokenWords) {
      if (chosen.length) break;
      const clipped = sentence.split(/\s+/).slice(0, maxSpokenWords).join(" ").replace(/[,;:]$/, "");
      chosen.push(/[.!?]$/.test(clipped) ? clipped : `${clipped}.`);
      break;
    }
    if (isQuestion) questions += 1;
    chosen.push(sentence);
    spokenWords += sentenceWords.length;
    if (chosen.length >= 3 || spokenWords >= maxSpokenWords) break;
  }
  return chosen.join(" ").trim();
}

async function captureAutomaticTurn(generation) {
  const wav = join(runtime, "visitor.wav");
  return new Promise((resolveTurn, reject) => {
    let heardSpeech = false;
    let finished = false;
    let captureError = "";
    const child = spawn("ffmpeg", [
      "-y", "-hide_banner", "-f", "avfoundation", "-i", ":default",
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
    const wav = join(runtime, "visitor.wav");
    await processAudioTurn(wav, join(runtime, "skelly.wav"), generation, true, "local");
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

async function renderSpeech(text, config, generation, output, prefix = "voice") {
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
  const raw = join(runtime, `${prefix}-voice-${generation}.aiff`);
  await runVoice("say", ["-v", config.voice, "-r", String(config.voiceRate), "-o", raw, clean], { timeoutMs: 30000 });
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
  await runVoice("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", raw, "-af", effects, output], { timeoutMs: 30000 });
  assertCurrentTurn(generation);
  await unlink(raw).catch(() => {});
}

async function speak(text, config, generation = turnGeneration) {
  const output = join(runtime, "skelly.wav");
  try {
    await renderSpeech(text, config, generation, output, "test");
    await runVoice("afplay", [output]);
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

async function bufferBody(request, maximumBytes = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("Audio upload is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(response, code, value, type = "application/json") {
  response.writeHead(code, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
  response.end(type === "application/json" ? JSON.stringify(value) : value);
}

function sendAudio(response, audio, transcript, reply) {
  response.writeHead(200, {
    "content-type": "audio/wav",
    "content-length": audio.length,
    "cache-control": "no-store",
    "x-skelly-transcript": Buffer.from(transcript).toString("base64url"),
    "x-skelly-reply": Buffer.from(reply).toString("base64url")
  });
  response.end(audio);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    const remoteApi = url.pathname.startsWith("/api/pi/") || url.pathname.startsWith("/api/remote/");
    const apiPath = url.pathname.replace(/^\/api\/pi\//, "/api/remote/");
    if (!isLoopback(request) && !remoteApi) {
      return send(response, 403, { error: "The Talking Skelly control panel is only available on the Mac." });
    }
    if (request.method === "GET" && url.pathname === "/") {
      return send(response, 200, await readFile(join(root, "web", "index.html"), "utf8"), "text/html");
    }
    if (request.method === "GET" && url.pathname === "/api/status") return send(response, 200, await status());
    if (request.method === "GET" && url.pathname === "/api/voices") return send(response, 200, { voices: await listVoices() });
    if (request.method === "GET" && url.pathname === "/api/models") return send(response, 200, { models: await listModels() });
    if (request.method === "GET" && apiPath === "/api/remote/setup") {
      if (!isLoopback(request)) return send(response, 403, { error: "Remote setup is only visible on the Mac Ultra." });
      return send(response, 200, { token: piToken, urls: localServerUrls(serverPort) });
    }
    if (remoteApi && !piIsAuthorized(request)) {
      return send(response, 401, { error: "Invalid remote front-end access token." });
    }
    if (request.method === "GET" && apiPath === "/api/remote/health") {
      return send(response, 200, { ok: true, busy, generation: turnGeneration });
    }
    if (request.method === "POST" && apiPath === "/api/remote/flush") {
      const result = flushCurrentTurn();
      remoteState = {
        ...remoteState,
        state: "ready",
        detail: "Current turn flushed",
        lastSeen: Date.now()
      };
      return send(response, 200, { ...result, generation: turnGeneration });
    }
    if (request.method === "POST" && apiPath === "/api/remote/status") {
      const update = await jsonBody(request);
      remoteState = {
        state: String(update.state || "online").slice(0, 40),
        detail: String(update.detail || "").slice(0, 160),
        client: String(update.client || "Remote front end").slice(0, 60),
        lastSeen: Date.now()
      };
      return send(response, 200, { ok: true });
    }
    if (request.method === "POST" && apiPath === "/api/remote/turn") {
      if (busy || recorder) return send(response, 409, { error: "Skelly is already processing another turn." });
      const audio = await bufferBody(request);
      if (audio.length < 1000) return send(response, 400, { error: "The remote front end sent an empty recording." });

      const generation = turnGeneration;
      const speechOffset = Number.parseFloat(request.headers["x-skelly-speech-offset"] || "0");
      const stamp = Date.now();
      const input = join(runtime, `pi-visitor-${stamp}.wav`);
      const output = join(runtime, `pi-skelly-${stamp}.wav`);
      const cancelDisconnectedTurn = () => {
        if (!response.writableEnded && generation === turnGeneration) {
          flushCurrentTurn();
          remoteState = {
            ...remoteState,
            state: "ready",
            detail: "Disconnected turn cancelled",
            lastSeen: Date.now()
          };
        }
      };
      await writeFile(input, audio);
      response.once("close", cancelDisconnectedTurn);
      busy = true;
      last.error = "";
      remoteState = { ...remoteState, state: "thinking", detail: "Mac is transcribing and answering", lastSeen: Date.now() };
      try {
        const turn = await processAudioTurn(input, output, generation, false, `pi-${stamp}`, speechOffset);
        if (!turn) return send(response, 422, { error: "No clear speech was detected." });
        const rendered = await readFile(output);
        remoteState = { ...remoteState, state: "speaking", detail: turn.reply, lastSeen: Date.now() };
        return sendAudio(response, rendered, turn.transcript, turn.reply);
      } catch (error) {
        assertCurrentTurn(generation);
        throw error;
      } finally {
        response.off("close", cancelDisconnectedTurn);
        if (generation === turnGeneration) busy = false;
        await unlink(input).catch(() => {});
        await unlink(output).catch(() => {});
      }
    }
    if (request.method === "POST" && url.pathname === "/api/record/start") {
      await startRecording();
      return send(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/record/stop") {
      await stopRecordingAndAnswer();
      return send(response, 200, { ok: true, ...last });
    }
    if (request.method === "POST" && url.pathname === "/api/conversation/start") {
      if (deploymentMode === "pi") {
        last.error = "";
        return send(response, 200, { ok: true, remoteMode: true });
      }
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
      const allowed = ["ollamaModel", "voiceRate", "pitchSemitones", "systemPrompt"];
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

const serverHost = process.env.SKELLY_LISTEN_HOST || (deploymentMode === "pi" ? "0.0.0.0" : "127.0.0.1");
server.listen(serverPort, serverHost, () => {
  console.log(`Talking Skelly (${deploymentMode}): http://127.0.0.1:${serverPort}`);
  if (serverHost !== "127.0.0.1") console.log(`Remote front-end access enabled on port ${serverPort}`);
});
