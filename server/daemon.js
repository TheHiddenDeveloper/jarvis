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
const TRANSCRIBE = join(JARVIS_DIR, "scripts/transcribe.py");
const OPENCODE = process.env.OPENCODE_BIN || "opencode";
const PIPER = process.env.JARVIS_PIPER || join(JARVIS_DIR, "venv/bin/piper");
const PIPER_MODEL =
  process.env.JARVIS_PIPER_MODEL || join(JARVIS_DIR, "models/piper/en_US-lessac-medium.onnx");
const PORT = Number(process.env.JARVIS_PORT || 7878);

mkdirSync(STATE_DIR, { recursive: true });

function getToken() {
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();
  const token = randomBytes(24).toString("hex");
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}
const TOKEN = process.env.JARVIS_API_TOKEN || getToken();

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

// Run the jarvis agent in a persistent session; returns the raw output.
async function runAgent(prompt) {
  let sid = readSessionId();
  let args;
  if (sid) {
    args = ["run", "-s", sid, "--agent", "jarvis", prompt];
  } else {
    args = ["run", "--agent", "jarvis", "--title", "jarvis daemon", prompt];
  }
  if (process.env.JARVIS_DEBUG) console.error(`[runAgent] opencode ${args.slice(0, 4).join(" ")}`);
  const out = await runOpencode(args);
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

async function transcribeFile(wavPath) {
  const { stdout } = await execFileAsync(VENV_PY, [TRANSCRIBE, wavPath], { timeout: 180000 });
  return stdout.trim();
}

async function transcribe(audioB64) {
  const raw = join(STATE_DIR, "upload.bin");
  const wav = join(STATE_DIR, "upload.wav");
  writeFileSync(raw, Buffer.from(audioB64, "base64"));
  try {
    await execFileAsync("ffmpeg", ["-y", "-i", raw, "-ar", "16000", "-ac", "1", wav], {
      timeout: 30000,
    });
    return await transcribeFile(wav);
  } finally {
    for (const f of [raw, wav]) {
      try {
        unlinkSync(f);
      } catch {}
    }
  }
}

async function speak(text) {
  const txt = join(STATE_DIR, "reply.txt");
  const wav = join(STATE_DIR, "reply.wav");
  writeFileSync(txt, text);
  try {
    await execFileAsync(PIPER, ["--model", PIPER_MODEL, "--input_file", txt, "--output_file", wav], {
      timeout: 30000,
    });
    return readFileSync(wav).toString("base64");
  } finally {
    for (const f of [txt, wav]) {
      try {
        unlinkSync(f);
      } catch {}
    }
  }
}

// Turn a user utterance into a reply + piper audio (voice-mode prompt).
async function handleUtterance(userText) {
  const reply = await extractReply(await runAgent(
    `You are Jarvis in VOICE MODE. The user said: "${userText}". ` +
      `Respond conversationally and briefly (1-3 short sentences), the way a voice assistant would. ` +
      `Output ONLY a JSON object of the form {"reply": "your spoken reply"}. ` +
      `Do NOT use any tools. Do NOT call "say". No markdown, no commentary, nothing else.`
  ));
  const audioB64Reply = await speak(reply);
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
});
