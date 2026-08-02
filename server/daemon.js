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
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

const HOME = homedir();
const JARVIS_DIR = join(HOME, "jarvis");
const STATE_DIR = join(JARVIS_DIR, "state");
const PUBLIC_DIR = join(JARVIS_DIR, "server", "public");
const SESSION_FILE = join(STATE_DIR, "server-session.id");
const VOICE_SESSION_FILE = join(STATE_DIR, "voice-session.id");
const VOICE_TITLE = "jarvis voice";
const CHIME_FILE = join(STATE_DIR, "chime.wav");
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
// Watchdog budgets: bound worst-case waits so a stuck model can't hold a
// session (and the user) for the full 120s request timeout.
const FIRST_DELTA_MS = Number(process.env.JARVIS_FIRST_DELTA_MS || 25000);
const FAST_REPLY_MS = Number(process.env.JARVIS_FAST_REPLY_MS || 12000);

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpJson(url, { method = "GET", body, auth, timeoutMs = 10000, signal } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  // Merge an external abort signal (e.g. a watchdog) with the timeout.
  const sig = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        ...(auth ? { Authorization: auth } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: sig,
    });
    if (!resp.ok) throw new Error(`http ${resp.status} ${url}`);
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

// Simple circuit breaker: after maxFailures consecutive failures the breaker
// opens for openMs, during which calls fail fast instead of hammering the
// service (or waiting out long boot deadlines) on every request.
function createBreaker({ maxFailures = 3, openMs = 15000 } = {}) {
  let failures = 0;
  let openedAt = null;
  return {
    ok() {
      failures = 0;
      openedAt = null;
    },
    fail() {
      if (openedAt) return;
      failures++;
      if (failures >= maxFailures) openedAt = Date.now();
    },
    isOpen() {
      if (openedAt && Date.now() - openedAt >= openMs) {
        openedAt = null;
        failures = 0; // half-open: allow one probe through
      }
      return openedAt !== null;
    },
  };
}

class ServiceUnavailableError extends Error {}

let speechProc = null;
let ocProc = null;
let ocHealthyAt = 0;
let speechHealthyAt = 0;
const ocBreaker = createBreaker();
const speechBreaker = createBreaker();

// Ensure the warm opencode serve process is up; returns its base URL.
//   force: bypass the circuit breaker + health memo (used by the background
//          event loop so a crashed server is respawned promptly).
// On the request path a recently-confirmed health check is reused (no
// round-trip), and when the breaker is open the call fails fast.
async function spawnOcServer({ force = false } = {}) {
  const base = `http://127.0.0.1:${OC_PORT}`;
  if (!force) {
    if (ocBreaker.isOpen()) throw new ServiceUnavailableError("opencode serve is temporarily unavailable");
    if (ocProc && ocProc.exitCode === null && Date.now() - ocHealthyAt < 5000) return base;
  }
  if (ocProc && ocProc.exitCode === null) {
    try {
      const r = await fetch(`${base}/health`, {
        headers: { Authorization: OC_AUTH },
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) {
        ocHealthyAt = Date.now();
        ocBreaker.ok();
        return base;
      }
      ocBreaker.fail();
    } catch {
      ocBreaker.fail();
    }
    if (!force && ocBreaker.isOpen()) {
      throw new ServiceUnavailableError("opencode serve is temporarily unavailable");
    }
  }
  // (Re)spawn: kill a hung process so the port frees up, then boot fresh.
  if (ocProc && ocProc.exitCode === null) {
    try {
      ocProc.kill("SIGKILL");
    } catch {}
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
      if (r.ok) {
        ocHealthyAt = Date.now();
        ocBreaker.ok();
        return base;
      }
    } catch {}
    await sleep(500);
  }
  ocBreaker.fail();
  throw new ServiceUnavailableError("opencode serve did not become healthy");
}

// Ensure the warm speech server (whisper + piper) is up.
async function ensureSpeech({ force = false } = {}) {
  const base = `http://127.0.0.1:${SPEECH_PORT}`;
  if (!force) {
    if (speechBreaker.isOpen()) throw new ServiceUnavailableError("speech server is temporarily unavailable");
    if (speechProc && speechProc.exitCode === null && Date.now() - speechHealthyAt < 5000) return;
  }
  if (speechProc && speechProc.exitCode === null) {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        speechHealthyAt = Date.now();
        speechBreaker.ok();
        return;
      }
      speechBreaker.fail();
    } catch {
      speechBreaker.fail();
    }
    if (!force && speechBreaker.isOpen()) {
      throw new ServiceUnavailableError("speech server is temporarily unavailable");
    }
  }
  if (speechProc && speechProc.exitCode === null) {
    try {
      speechProc.kill("SIGKILL");
    } catch {}
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
      if (r.ok) {
        speechHealthyAt = Date.now();
        speechBreaker.ok();
        return;
      }
    } catch {}
    await sleep(500);
  }
  speechBreaker.fail();
  throw new ServiceUnavailableError("speech server did not become healthy");
}

// ---------------------------------------------------------------- helpers

function readSessionId(file = SESSION_FILE) {
  if (existsSync(file)) {
    const id = readFileSync(file, "utf8").trim();
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

// Ensure a warm session exists (create on demand) and return its id.
async function ensureSession(sessionFile, title) {
  const base = await spawnOcServer();
  let sid = readSessionId(sessionFile);
  if (!sid) {
    const s = await httpJson(`${base}/session`, {
      method: "POST",
      auth: OC_AUTH,
      body: { directory: SERVER_DIR, title },
      timeoutMs: 20000,
    });
    sid = s.id;
    writeFileSync(sessionFile, sid);
  }
  return sid;
}

// Thrown when a generation exceeds its watchdog budget (no first delta, or no
// reply at all). The caller decides how to degrade.
class GenerationTimeoutError extends Error {}

// Run the prompt against the warm opencode server (no per-request process boot).
// Returns the assistant's raw text reply. When onDelta is given, incremental
// reply text is pushed to it as the model generates (via /global/event).
// Watchdog: if firstDeltaMs is set and no delta arrives in time, or if
// replyTimeoutMs is set and no reply arrives in time, the generation is
// aborted on the server (POST /session/:id/abort) and GenerationTimeoutError
// is thrown — this bounds worst-case waits instead of letting a stuck model
// hold the session for the full 120s.
async function runAgentWarm(prompt, { agent = "jarvis", sessionFile = SESSION_FILE, title = "jarvis daemon", onDelta, firstDeltaMs = 0, replyTimeoutMs = 0 } = {}) {
  const base = await spawnOcServer();
  const sid = await ensureSession(sessionFile, title);
  const ctrl = new AbortController();
  const budget = onDelta ? firstDeltaMs : replyTimeoutMs;
  let gotFirst = false;
  let timedOut = false;
  let timer = null;
  const unwatch = onDelta
    ? watchGeneration(sid, (d) => {
        if (!gotFirst) {
          gotFirst = true;
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
        }
        onDelta(d);
      })
    : null;
  if (budget > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
      httpJson(`${base}/session/${sid}/abort`, {
        method: "POST",
        auth: OC_AUTH,
        timeoutMs: 10000,
      }).catch(() => {});
    }, budget);
  }
  try {
    const resp = await httpJson(`${base}/session/${sid}/message`, {
      method: "POST",
      auth: OC_AUTH,
      body: { agent, parts: [{ type: "text", text: prompt }] },
      timeoutMs: 120000,
      signal: ctrl.signal,
    });
    const text = (resp.parts || [])
      .filter((p) => p.type === "text")
      .map((p) => p.text || "")
      .join(" ")
      .trim();
    if (!text) throw new Error("warm agent returned no text part");
    return text;
  } catch (e) {
    if (timedOut) throw new GenerationTimeoutError("generation exceeded its time budget");
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    if (unwatch) unwatch();
  }
}

// Run the jarvis agent in a persistent session; returns the raw output.
async function runAgent(prompt, onDelta) {
  const t0 = Date.now();
  try {
    const out = await runAgentWarm(prompt, { onDelta, firstDeltaMs: FIRST_DELTA_MS });
    if (process.env.JARVIS_DEBUG) console.error(`[runAgent] warm ok in ${Date.now() - t0}ms`);
    return out;
  } catch (e) {
    if (e instanceof GenerationTimeoutError) throw e; // don't compound the wait with a CLI fallback
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

// ------------------------------------------------------------ voice routing

// Utterances matching these patterns need the full jarvis agent (tools/MCP);
// everything else can take the lean jarvis-voice fast path.
const TASK_RE = [
  /\b(open|launch|start|run|play|close|quit|kill)\b.*\b(spotify|vscode|code|chrome|brave|firefox|obsidian|kate|gedit|telegram|whatsapp|slack|discord|gimp|krita|terminal|konsole|files|dolphin|nautilus|steam|browser|app)\b/,
  /\b(search|look up|look for|google|find|research|check|fetch|browse|navigate)\b/,
  /\b(create|make|write|edit|delete|remove|rename|move|copy|organize|convert|download|upload|save|backup|clean)\b.*\b(file|folder|directory|document|note|image|video|music|playlist|pdf|script|tab)\b/,
  /\b(install|uninstall|update|upgrade)\b/,
  /\b(restart|reboot|shutdown|sleep|lock|power off)\b/,
  /\b(volume|brightness|screenshot|notification|notify|remind|reminder|timer|alarm|schedule|calendar|email|message|call)\b/,
  /\b(weather|forecast|temperature|wifi|bluetooth|network|time|date)\b/,
];

function isTaskRequest(text) {
  const t = text.toLowerCase();
  return TASK_RE.some((re) => re.test(t));
}

function normalizePlain(s) {
  let t = s.trim();
  t = t.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t.replace(/\s+/g, " ").trim();
}

function isTaskEscalation(s) {
  return normalizePlain(s).toLowerCase().replace(/[^a-z]/g, "") === "task";
}

// Full jarvis agent in voice mode (existing behavior): JSON envelope reply.
async function runJarvisVoice(userText, onDelta) {
  const out = await runAgent(
    `You are Jarvis in VOICE MODE. The user said: "${userText}". ` +
      `Respond conversationally and briefly (1-3 short sentences), the way a voice assistant would. ` +
      `Output ONLY a JSON object of the form {"reply": "your spoken reply"}. ` +
      `Do NOT use any tools. Do NOT call "say". No markdown, no commentary, nothing else.`,
    onDelta
  );
  return await extractReply(out);
}

// Lean jarvis-voice agent on its own small session. Returns plain text, or
// exactly "TASK" when the request actually needs the full agent. A reply that
// exceeds FAST_REPLY_MS is aborted and replaced with a graceful line instead
// of leaving the user waiting on a stuck model.
async function runFastVoice(userText) {
  try {
    const out = await runAgentWarm(
      `[Fast voice mode] Today is ${new Date().toDateString()}. The user said: "${userText}". ` +
        `Reply in at most 2 short spoken sentences, plain text only, no markdown, no emojis, no JSON. ` +
        `If the request needs any action or info beyond your own knowledge (apps, files, web, system, ` +
        `scheduling, messages, real-time data), reply with exactly the single word: TASK`,
      { agent: "jarvis-voice", sessionFile: VOICE_SESSION_FILE, title: VOICE_TITLE, replyTimeoutMs: FAST_REPLY_MS }
    );
    return out;
  } catch (e) {
    if (e instanceof GenerationTimeoutError) {
      if (process.env.JARVIS_DEBUG) console.error("[voice] fast agent timed out; replying gracefully");
      return "Sorry, I got stuck for a moment. Give me a couple of seconds and ask again.";
    }
    if (process.env.JARVIS_DEBUG) {
      console.error(`[voice] fast agent failed (${e.message}); escalating to jarvis`);
    }
    return "TASK";
  }
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

// Turn a user utterance into a reply + piper audio. Routes chit-chat to the
// lean jarvis-voice agent (with TASK self-escalation) and tasks to jarvis.
async function handleUtterance(userText, onDelta) {
  const t0 = Date.now();
  let agent = "jarvis";
  let reply;
  if (isTaskRequest(userText)) {
    reply = await runJarvisVoice(userText, onDelta);
  } else {
    const fast = await runFastVoice(userText);
    if (isTaskEscalation(fast)) {
      reply = await runJarvisVoice(userText, onDelta);
    } else {
      agent = "jarvis-voice";
      reply = fast;
    }
  }
  const tAgent = Date.now();
  let audioB64Reply = "";
  try {
    audioB64Reply = await speak(reply);
  } catch (e) {
    // Degradation tier: if TTS fails we still deliver the text reply; the
    // client shows it without audio instead of the whole turn failing.
    if (process.env.JARVIS_DEBUG) console.error(`[utter] TTS failed: ${e.message}`);
  }
  if (process.env.JARVIS_DEBUG) {
    console.error(
      `[utter] agent=${agent} llm=${tAgent - t0}ms tts=${Date.now() - tAgent}ms total=${Date.now() - t0}ms`
    );
  }
  return { reply, audioB64: audioB64Reply };
}

// Serialize utterance handling: only one turn is processed at a time, so two
// overlapping requests can't double-fire the same warm session (opencode
// serves a per-session busy lock, but queueing here is deterministic and keeps
// the single-user widget from tripping over itself).
let utteranceChain = Promise.resolve();
function enqueueUtterance(fn) {
  const run = utteranceChain.then(fn, fn);
  utteranceChain = run.catch(() => {});
  return run;
}

// Accumulate streamed deltas server-side so the client shows the growing
// reply (not individual chunks) and stays correct across SSE reconnects.
function handleUtteranceStream(userText, send) {
  let acc = "";
  return handleUtterance(userText, (d) => {
    acc += d;
    send({ type: "delta", text: acc });
  });
}

// ------------------------------------------------------- streaming bridge

// Active generations, keyed by opencode sessionID -> Set<onDelta> callbacks.
// The daemon POSTs the prompt (blocking, returns the full reply) while a
// parallel subscription to opencode's /global/event SSE channel pushes the
// incremental text deltas to any interested client feed.
const genWatchers = new Map();

function watchGeneration(sessionID, onDelta) {
  if (!genWatchers.has(sessionID)) genWatchers.set(sessionID, new Set());
  const set = genWatchers.get(sessionID);
  set.add(onDelta);
  return () => {
    set.delete(onDelta);
    if (set.size === 0) genWatchers.delete(sessionID);
  };
}

function dispatchDelta(sessionID, text) {
  const set = genWatchers.get(sessionID);
  if (!set) return;
  for (const fn of [...set]) fn(text);
}

// Persistent SSE subscription to opencode's /global/event. Carries the
// incremental assistant text (message.part.delta) that the blocking message
// API does not expose. Reconnects forever; self-heals on server restarts.
async function connectOcEvents() {
  for (;;) {
    let base;
    try {
      base = await spawnOcServer({ force: true });
    } catch {
      await sleep(2000);
      continue;
    }
    try {
      const resp = await fetch(`${base}/global/event`, { headers: { Authorization: OC_AUTH } });
      if (!resp.ok || !resp.body) throw new Error(`event http ${resp.status}`);
      if (process.env.JARVIS_DEBUG) console.error("[events] connected to opencode /global/event");
      let buf = "";
      for await (const chunk of resp.body) {
        buf += Buffer.from(chunk).toString("utf8");
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = block.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let ev;
          try {
            ev = JSON.parse(line.slice(5));
          } catch {
            continue;
          }
          const p = ev && ev.payload;
          if (
            p &&
            p.type === "message.part.delta" &&
            p.properties &&
            p.properties.field === "text"
          ) {
            dispatchDelta(p.properties.sessionID, p.properties.delta || "");
          }
        }
      }
    } catch (e) {
      if (process.env.JARVIS_DEBUG) {
        console.error(`[events] connection dropped (${e.message}); reconnecting`);
      }
    }
    await sleep(1000);
  }
}

// ---------------------------------------------------------------- setup

// Keep the lean voice agent installed (committed template -> ~/.config/opencode).
function ensureVoiceAgent() {
  const src = join(JARVIS_DIR, "server", "opencode-agents", "jarvis-voice.md");
  const dest = join(HOME, ".config", "opencode", "agents", "jarvis-voice.md");
  if (!existsSync(src)) return;
  const content = readFileSync(src, "utf8");
  if (existsSync(dest) && readFileSync(dest, "utf8") === content) return;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content, { mode: 0o600 });
  if (process.env.JARVIS_DEBUG) console.error("[setup] installed jarvis-voice agent");
}

// Subtle two-tone reflex chime the client plays the instant the user submits.
async function ensureChime() {
  if (existsSync(CHIME_FILE)) return;
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-f", "lavfi", "-i", "sine=frequency=880:duration=0.12",
        "-f", "lavfi", "-i", "sine=frequency=1174.66:duration=0.22",
        "-filter_complex",
        "[0:a]volume=0.35,afade=t=in:st=0:d=0.004,afade=t=out:st=0.08:d=0.04[a];" +
          "[1:a]volume=0.3,afade=t=in:st=0:d=0.004,afade=t=out:st=0.16:d=0.06[b];" +
          "[a][b]concat=n=2:v=0:a=1",
        "-ar", "44100", "-ac", "1", CHIME_FILE,
      ],
      { timeout: 15000 }
    );
  } catch (e) {
    if (process.env.JARVIS_DEBUG) console.error(`[setup] chime generation failed: ${e.message}`);
  }
}

// Send a throwaway message to a warm session and revert it, so MCP/models are
// pre-loaded and the first real request is fast without polluting history.
async function warmSession(agent, sessionFile, title) {
  const base = await spawnOcServer();
  const sid = await ensureSession(sessionFile, title);
  try {
    const resp = await httpJson(`${base}/session/${sid}/message`, {
      method: "POST",
      auth: OC_AUTH,
      body: { agent, parts: [{ type: "text", text: "Reply with exactly: OK" }] },
      timeoutMs: 90000,
    });
    const messageID = resp && resp.info && resp.info.id;
    if (messageID) {
      await httpJson(`${base}/session/${sid}/revert`, {
        method: "POST",
        auth: OC_AUTH,
        body: { messageID },
        timeoutMs: 30000,
      }).catch(() => {});
    }
    if (process.env.JARVIS_DEBUG) console.error(`[warm] ${agent} session ready`);
  } catch (e) {
    if (process.env.JARVIS_DEBUG) console.error(`[warm] ${agent} failed: ${e.message}`);
  }
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

// Turn a response into an SSE stream; returns a send(obj) function.
function sseInit(res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  return (obj) => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {}
  };
}

// Map internal failures to user-facing messages (stability: never leak raw
// stack/URL noise, and give actionable text for the common failure modes).
function friendlyError(e) {
  if (e instanceof GenerationTimeoutError) {
    return "That one took too long — I've stopped it. Try asking again.";
  }
  if (e instanceof ServiceUnavailableError) {
    return "Jarvis's brain is restarting — give me a moment and try again.";
  }
  return String(e.message || e);
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, session: readSessionId(), voiceSession: readSessionId(VOICE_SESSION_FILE), auth: true });
});

// Reflex chime, public (it's just a sound).
app.get("/chime.wav", (req, res) => {
  if (!existsSync(CHIME_FILE)) return res.status(404).end();
  res.sendFile(CHIME_FILE);
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
  const send = sseInit(res);
  try {
    await enqueueUtterance(async () => {
      await stopMic();
      const userText = await transcribeFile(MIC_FILE);
      if (!userText) return send({ type: "error", message: "no speech detected" });
      send({ type: "user", text: userText });
      const { reply, audioB64 } = await handleUtteranceStream(userText, send);
      send({ type: "done", reply, audioB64, mime: "audio/wav" });
    });
  } catch (e) {
    send({ type: "error", message: friendlyError(e) });
  } finally {
    res.end();
  }
});

app.post("/api/ask", auth, async (req, res) => {
  const send = sseInit(res);
  try {
    const { audioB64, text } = req.body || {};
    let userText = typeof text === "string" ? text.trim() : "";
    if (!userText && audioB64) userText = await transcribe(audioB64);
    if (!userText) return send({ type: "error", message: "no text or audio provided" });
    await enqueueUtterance(async () => {
      send({ type: "user", text: userText });
      const { reply, audioB64: audioB64Reply } = await handleUtteranceStream(userText, send);
      send({ type: "done", reply, audioB64: audioB64Reply, mime: "audio/wav" });
    });
  } catch (e) {
    send({ type: "error", message: friendlyError(e) });
  } finally {
    res.end();
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Jarvis daemon ready.");
  console.log(`  Local URL:  http://localhost:${PORT}`);
  console.log(`  API token:  ${TOKEN}`);
  console.log(`  (token also in ${TOKEN_FILE}; pass in Authorization: Bearer <token>)`);
  ensureVoiceAgent();
  ensureChime();
  // Warm the helper servers in the background so the first request is fast.
  ensureSpeech()
    .then(() => {
      if (process.env.JARVIS_DEBUG) console.error("[warm] speech server ready");
    })
    .catch((e) => console.error(`[warm] speech server failed: ${e.message}`));
  spawnOcServer()
    .then(() => {
      if (process.env.JARVIS_DEBUG) console.error("[warm] opencode serve ready");
      connectOcEvents();
      warmSession("jarvis", SESSION_FILE, "jarvis daemon");
      warmSession("jarvis-voice", VOICE_SESSION_FILE, VOICE_TITLE);
    })
    .catch((e) => console.error(`[warm] opencode serve failed: ${e.message}`));
});
