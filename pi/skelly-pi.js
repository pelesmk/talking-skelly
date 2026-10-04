#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const runtime = join(root, ".runtime", "pi");
const configPath = process.env.SKELLY_PI_CONFIG || join(here, "config.json");
await mkdir(runtime, { recursive: true });

let running = true;
let activeProcess = null;
let currentState = "starting";
let currentDetail = "Connecting to the Mac";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const config = JSON.parse(await readFile(configPath, "utf8"));
const serverUrl = String(config.serverUrl || "").replace(/\/$/, "");
const token = String(config.token || "");

if (!serverUrl || !token || token.includes("PASTE_TOKEN")) {
  throw new Error(`Complete ${configPath} with the Mac server URL and Pi token first.`);
}

function headers(extra = {}) {
  return { authorization: `Bearer ${token}`, ...extra };
}

async function api(path, options = {}, timeout = 120000) {
  const response = await fetch(`${serverUrl}${path}`, {
    ...options,
    headers: headers(options.headers),
    signal: AbortSignal.timeout(timeout)
  });
  return response;
}

async function sendStatus(state = currentState, detail = currentDetail) {
  currentState = state;
  currentDetail = detail;
  await api("/api/remote/status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state, detail, client: "Raspberry Pi" })
  }, 5000);
}

function captureTurn(output) {
  return new Promise((resolve, reject) => {
    const threshold = Number(config.silenceThresholdDb ?? -38);
    const silence = Number(config.silenceDurationSeconds ?? 1.1);
    const maximum = Number(config.maxListenSeconds ?? 45);
    const args = [
      "-y", "-hide_banner", "-f", config.inputFormat || "pulse",
      "-i", config.inputDevice || "default",
      "-ac", "1", "-ar", "16000",
      "-af", `silencedetect=noise=${threshold}dB:d=${silence}`,
      "-c:a", "pcm_s16le", output
    ];
    const child = spawn(config.ffmpeg || "ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
    activeProcess = child;
    let heardSpeech = false;
    let requestedStop = false;
    let successfulTurn = false;
    let stderr = "";

    const timer = setTimeout(() => stop(false), maximum * 1000);
    function stop(success) {
      if (requestedStop) return;
      requestedStop = true;
      successfulTurn = success;
      clearTimeout(timer);
      if (child.stdin.writable) child.stdin.write("q\n");
      else child.kill("SIGTERM");
    }

    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      if (text.includes("silence_end:")) heardSpeech = true;
      if (heardSpeech && text.includes("silence_start:")) stop(true);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      activeProcess = null;
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      activeProcess = null;
      if (!running) return resolve(null);
      if (requestedStop) return resolve(successfulTurn ? output : null);
      if (code === 0) return resolve(heardSpeech ? output : null);
      reject(new Error(stderr.trim() || `Microphone capture exited with ${code}`));
    });
  });
}

function decodeHeader(value) {
  return value ? Buffer.from(value, "base64url").toString("utf8") : "";
}

async function sendTurn(recording, responseFile) {
  const audio = await readFile(recording);
  const response = await api("/api/remote/turn", {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: audio
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 422) return null;
    throw new Error(data.error || `Mac returned ${response.status}`);
  }
  if (!response.headers.get("content-type")?.startsWith("audio/wav")) {
    throw new Error("Mac did not return Skelly audio. The turn may have been flushed.");
  }
  await writeFile(responseFile, Buffer.from(await response.arrayBuffer()));
  return {
    transcript: decodeHeader(response.headers.get("x-skelly-transcript")),
    reply: decodeHeader(response.headers.get("x-skelly-reply"))
  };
}

function playAudio(file) {
  const command = config.player || "ffplay";
  const args = command.endsWith("aplay")
    ? [file]
    : ["-nodisp", "-autoexit", "-loglevel", "error", file];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    activeProcess = child;
    child.once("error", reject);
    child.once("exit", (code) => {
      activeProcess = null;
      if (code === 0 || !running) resolve();
      else reject(new Error(`Audio player exited with ${code}`));
    });
  });
}

async function conversationLoop() {
  const recording = join(runtime, "visitor.wav");
  const responseFile = join(runtime, "skelly.wav");

  while (running) {
    try {
      await sendStatus("listening", "Waiting for a visitor");
      const captured = await captureTurn(recording);
      if (!running) break;
      if (!captured) continue;

      await sendStatus("thinking", "Sending the visitor to the Mac");
      const turn = await sendTurn(captured, responseFile);
      if (!turn) continue;
      console.log(`Visitor: ${turn.transcript}`);
      console.log(`Skelly: ${turn.reply}`);

      await sendStatus("speaking", turn.reply);
      await playAudio(responseFile);
      await unlink(responseFile).catch(() => {});
    } catch (error) {
      console.error(`[Talking Skelly] ${error.message}`);
      currentState = "error";
      currentDetail = error.message;
      await sleep(3000);
    }
  }
}

function shutdown() {
  running = false;
  if (activeProcess) activeProcess.kill("SIGTERM");
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const heartbeat = setInterval(() => sendStatus().catch(() => {}), 5000);
try {
  const health = await api("/api/remote/health", {}, 5000);
  if (!health.ok) throw new Error(`Mac health check returned ${health.status}`);
  console.log(`[Talking Skelly] Connected to ${serverUrl}`);
  await conversationLoop();
} finally {
  clearInterval(heartbeat);
  await sendStatus("offline", "Pi client stopped").catch(() => {});
}
