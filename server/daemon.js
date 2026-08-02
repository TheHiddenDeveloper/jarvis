#!/usr/bin/env node
// jarvis-daemon: local voice-assistant server.
//
//   - Serves the web app (PWA) from ./public on one port.
//   - POST /api/ask accepts voice audio or text from any client:
//       audioB64 -> faster-whisper -> persistent opencode session -> piper TTS -> base64 wav reply
//   - Bearer-token auth; token auto-generated at ~/jarvis/state/server.token
//
// Usage: node daemon.js   (env: JARVIS_PORT, JARVIS_API_TOKEN)
import express from "express";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const HOME = homedir();
const JARVIS_DIR = join(HOME, "jarvis");
const STATE_DIR = join(JARVIS_DIR, "state");
const PUBLIC_DIR = join(JARVIS_DIR, "server", "public");
const SESSION_FILE = join(STATE_DIR, "server-session.id");
const TOKEN_FILE = join(STATE_DIR, "server.token");
const VENV_PY = join(JARVIS_DIR, "venv/bin/python");
const OPENCODE = process.env.OPENCODE_BIN || "opencode";
const PORT = Number(process.env.JARVIS_PORT || 7878);
// Resuming an existing session takes a while; if it yields nothing (e.g. the
// session's directory no longer matches our cwd) we drop the id and retry fresh
// rather than burning the full agent timeout.
const RESUME_TIMEOUT_MS = Number(process.env.JARVIS_RESUME_TIMEOUT || 60000);
// Warm helper servers the daemon spawns and keeps alive (no per-request cold starts):
const SPEECH_PORT = Number(process.env.JARVIS_SPEECH_PORT || 7888);
const OC_PORT = Number(process.env.JARVIS_OPENCODE_PORT || 4096);
const OC_PASSWORD_FILE = join(STATE_DIR, "opencode-server.password");

mkdirSync(STATE_DIR, { recursive: true });

function getToken() {
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();
  const token = randomBytes(24).toString("hex");
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}
const TOKEN = process.env.JARVIS_API_TOKEN || getToken();

function getOcPassword() {
  if (existsSync(OC_PASSWORD_FILE)) return readFileSync(OC_PASSWORD_FILE, "utf8").trim();
  const p = randomBytes(16).toString("hex");
  writeFileSync(OC_PASSWORD_FILE, p, { mode: 0o600 });
  return p;
}
const OC_AUTH = "Basic " + Buffer.from(`opencode:${getOcPassword()}`).toString("base64");

const SERVER_DIR = join(JARVIS_DIR, "server");
const MIC_FILE = join(STATE_DIR, "host-mic.wav");

function isLoopback(addr) {
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    (typeof addr === "string" && addr.startsWith("::ffff:127."))
  );
}

let micProc = null;
let micTimer = null;

function stopMic() {
  if (micTimer) {
    clearTimeout(micTimer);
    micTimer = null;
  }
  const proc = micProc;
  micProc = null;
  if (!proc || proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, 3000);
    proc.on("exit", () => {
      clearTimeout(t);
      resolve();
    });
    try {
      proc.kill("SIGTERM");
    } catch {
      resolve();
    }
  });
}

// Run opencode. IMPORTANT: must use spawn with stdio ['ignore', ...] — Node's
// exec() pipe-for-stdin makes opencode hang at "init" (verified empirically).
function runOpencode(args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const child = spawn(OPENCODE, args, {
      cwd: SERVER_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

// ---------------------------------------------------------------- warm servers

let speechProc = null;
let ocProc = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpJson(url, { method = "GET", body, auth, timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        ...(auth ? { Authorization: auth } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`http ${resp.status} ${url}`);
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

// Ensure the warm opencode serve process is up; returns its base URL.
async function spawnOcServer() {
  const base = `http://127.0.0.1:${OC_PORT}`;
  if (ocProc && ocProc.exitCode === null) {
    try {
      const r = await fetch(`${base}/health`, {
        headers: { Authorization: OC_AUTH },
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return base;
    } catch {
      /* fall through to respawn */
    }
  }
  ocProc = spawn(OPENCODE, ["serve", "--port", String(OC_PORT), "--hostname", "127.0.0.1"], {
    cwd: SERVER_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: getOcPassword() },
  });
  ocProc.on("exit", () => {
    ocProc = null;
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`, {
        headers: { Authorization: OC_AUTH },
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return base;
    } catch {}
    await sleep(500);
  }
  throw new Error("opencode serve did not become healthy");
}

// Ensure the warm speech server (whisper + piper) is up.
async function ensureSpeech() {
  const base = `http://127.0.0.1:${SPEECH_PORT}`;
  if (speechProc && speechProc.exitCode === null) {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {
      /* fall through to respawn */
    }
  }
  speechProc = spawn(VENV_PY, [join(JARVIS_DIR, "scripts", "speech-server.py")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  speechProc.on("exit", () => {
    speechProc = null;
  });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error("speech server did not become healthy");
}

// ---------------------------------------------------------------- helpers

function readSessionId() {
  if (existsSync(SESSION_FILE)) {
    const id = readFileSync(SESSION_FILE, "utf8").trim();
    if (id) return id;
  }
  return null;
}

async function findSessionId(title) {
  const out = await runOpencode(["session", "list"], 15000);
  const line = out
    .split("\n")
    .map((l) => l.trim().split(/\s{2,}/))
    .find((parts) => parts.length >= 2 && parts[1] === title);
  const id = line ? line[0] : null;
  if (id) writeFileSync(SESSION_FILE, id);
  return id;
}

// Run the prompt against the warm opencode server (no per-request process boot).
// Returns the assistant's raw text reply.
async function runAgentWarm(prompt) {
  const base = await spawnOcServer();
  let sid = readSessionId();
  if (!sid) {
    const s = await httpJson(`${base}/session`, {
      method: "POST",
      auth: OC_AUTH,
      body: { directory: SERVER_DIR, title: "jarvis daemon" },
      timeoutMs: 20000,
    });
    sid = s.id;
    writeFileSync(SESSION_FILE, sid);
  }
  const resp = await httpJson(`${base}/session/${sid}/message`, {
    method: "POST",
    auth: OC_AUTH,
    body: { agent: "jarvis", parts: [{ type: "text", text: prompt }] },
    timeoutMs: 120000,
  });
  const text = (resp.parts || [])
    .filter((p) => p.type === "text")
    .map((p) => p.text || "")
    .join(" ")
    .trim();
  if (!text) throw new Error("warm agent returned no text part");
  return text;
}

// Run the jarvis agent in a persistent session; returns the raw output.
async function runAgent(prompt) {
  const t0 = Date.now();
  try {
    const out = await runAgentWarm(prompt);
    if (process.env.JARVIS_DEBUG) console.error(`[runAgent] warm ok in ${Date.now() - t0}ms`);
    return out;
  } catch (e) {
    if (process.env.JARVIS_DEBUG) {
      console.error(`[runAgent] warm failed (${e.message}); falling back to CLI`);
    }
  }
  let sid = readSessionId();
  if (sid) {
    const out = await runOpencode(["run", "-s", sid, "--agent", "jarvis", prompt], RESUME_TIMEOUT_MS);
    if (out.trim()) return out;
    // Resume produced nothing (hung session, moved directory, corrupt state).
    // Drop the stale id and fall back to a fresh session so the user gets a reply.
    if (process.env.JARVIS_DEBUG) {
      console.error(`[runAgent] resume of ${sid} empty after ${Date.now() - t0}ms; retrying fresh`);
    }
    try {
      unlinkSync(SESSION_FILE);
    } catch {}
    sid = null;
  }
  const out = await runOpencode(["run", "--agent", "jarvis", "--title", "jarvis daemon", prompt]);
  if (!sid) await findSessionId("jarvis daemon");
  return out;
}

function unwrapReply(s) {
  let cur = s.trim();
  for (let i = 0; i < 3; i++) {
    if (cur.startsWith("{")) {
      try {
        const obj = JSON.parse(cur);
        if (obj && typeof obj.reply === "string" && obj.reply.trim()) cur = obj.reply.trim();
        else return cur;
      } catch {
        return cur;
      }
    } else {
      return cur;
    }
  }
  return cur;
}

function extractReply(out) {
  const s = out.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj.reply === "string" && obj.reply.trim()) {
          return unwrapReply(obj.reply);
        }
      } catch {
        /* keep scanning */
      }
    }
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(s.slice(start, end + 1));
      if (obj && typeof obj.reply === "string" && obj.reply.trim()) {
        return unwrapReply(obj.reply);
      }
    } catch {
      /* fall through */
    }
  }
  const meaningful = lines.filter(
    (l) => !/^(>|⚙|✓|!|✗|•|Error)/.test(l) && !l.includes("jarvis-tools_") && !/^[{}";]/.test(l)
  );
  return meaningful[meaningful.length - 1] || "Sorry, I did not catch that.";
}

async function transcribeBytes(wavBytes) {
  await ensureSpeech();
  const resp = await fetch(`http://127.0.0.1:${SPEECH_PORT}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: wavBytes,
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`speech /transcribe ${resp.status}`);
  const d = await resp.json();
  return (d.text || "").trim();
}

async function transcribeFile(wavPath) {
  return await transcribeBytes(readFileSync(wavPath));
}

async function transcribe(audioB64) {
  const raw = join(STATE_DIR, "upload.bin");
  const wav = join(STATE_DIR, "upload.wav");
  writeFileSync(raw, Buffer.from(audioB64, "base64"));
  const t0 = Date.now();
  try {
    await execFileAsync("ffmpeg", ["-y", "-i", raw, "-ar", "16000", "-ac", "1", wav], {
      timeout: 30000,
    });
    const text = await transcribeBytes(readFileSync(wav));
    if (process.env.JARVIS_DEBUG) {
      console.error(`[transcribe] ${Date.now() - t0}ms -> "${text}"`);
    }
    return text;
  } finally {
    for (const f of [raw, wav]) {
      try {
        unlinkSync(f);
      } catch {}
    }
  }
}

async function speak(text) {
  await ensureSpeech();
  const resp = await fetch(`http://127.0.0.1:${SPEECH_PORT}/speak?json=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`speech /speak ${resp.status}`);
  const d = await resp.json();
  return d.wav_b64;
}

// Turn a user utterance into a reply + piper audio (voice-mode prompt).
async function handleUtterance(userText) {
  const t0 = Date.now();
  const out = await runAgent(
    `You are Jarvis in VOICE MODE. The user said: "${userText}". ` +
      `Respond conversationally and briefly (1-3 short sentences), the way a voice assistant would. ` +
      `Output ONLY a JSON object of the form {"reply": "your spoken reply"}. ` +
      `Do NOT use any tools. Do NOT call "say". No markdown, no commentary, nothing else.`
  );
  const tAgent = Date.now();
  const reply = await extractReply(out);
  const audioB64Reply = await speak(reply);
  if (process.env.JARVIS_DEBUG) {
    console.error(
      `[utter] agent=${tAgent - t0}ms tts=${Date.now() - tAgent}ms total=${Date.now() - t0}ms`
    );
  }
  return { reply, audioB64: audioB64Reply };
}

// ---------------------------------------------------------------- http

const app = express();
app.use(express.json({ limit: "30mb" }));
if (process.env.JARVIS_DEBUG) {
  app.use((req, res, next) => {
    console.error(`[req] ${req.method} ${req.originalUrl}`);
    next();
  });
}
app.use(express.static(PUBLIC_DIR));

function auth(req, res, next) {
  if (req.headers.authorization === `Bearer ${TOKEN}`) return next();
  res.status(401).json({ error: "unauthorized" });
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, session: readSessionId(), auth: true });
});

// Auto-login bootstrap: only reachable from the local machine.
app.get("/api/token", (req, res) => {
  if (isLoopback(req.socket.remoteAddress)) return res.json({ token: TOKEN });
  res.status(403).json({ error: "token only available on loopback" });
});

// Start/stop daemon-side mic capture (used by the desktop widget, where
// WebKitGTK denies getUserMedia). ffmpeg writes straight to 16k mono wav.
app.post("/api/mic/start", auth, (req, res) => {
  if (micProc) return res.status(409).json({ error: "already recording" });
  micProc = spawn(
    "ffmpeg",
    ["-y", "-f", "pulse", "-i", "default", "-af", "volume=8dB", "-ar", "16000", "-ac", "1", MIC_FILE],
    { stdio: "ignore" }
  );
  micProc.on("error", () => {
    micProc = null;
  });
  micTimer = setTimeout(() => {
    stopMic();
  }, 60000);
  res.json({ ok: true });
});

app.post("/api/mic/stop", auth, async (req, res) => {
  try {
    await stopMic();
    const userText = await transcribeFile(MIC_FILE);
    if (!userText) return res.status(400).json({ error: "no speech detected" });
    const { reply, audioB64 } = await handleUtterance(userText);
    res.json({ user: userText, reply, audioB64, mime: "audio/wav" });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/ask", auth, async (req, res) => {
  try {
    const { audioB64, text } = req.body || {};
    let userText = typeof text === "string" ? text.trim() : "";
    if (!userText && audioB64) userText = await transcribe(audioB64);
    if (!userText) return res.status(400).json({ error: "no text or audio provided" });
    const { reply, audioB64: audioB64Reply } = await handleUtterance(userText);
    res.json({ user: userText, reply, audioB64: audioB64Reply, mime: "audio/wav" });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Jarvis daemon ready.");
  console.log(`  Local URL:  http://localhost:${PORT}`);
  console.log(`  API token:  ${TOKEN}`);
  console.log(`  (token also in ${TOKEN_FILE}; pass in Authorization: Bearer <token>)`);
  // Warm the helper servers in the background so the first request is fast.
  ensureSpeech()
    .then(() => {
      if (process.env.JARVIS_DEBUG) console.error("[warm] speech server ready");
    })
    .catch((e) => console.error(`[warm] speech server failed: ${e.message}`));
  spawnOcServer()
    .then(() => {
      if (process.env.JARVIS_DEBUG) console.error("[warm] opencode serve ready");
    })
    .catch((e) => console.error(`[warm] opencode serve failed: ${e.message}`));
});
