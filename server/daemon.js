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
// Semantic reply cache: repeated/near-repeated chit-chat is answered from a
// local cache (embedding match against past replies) instead of the LLM.
const CACHE_FILE = join(STATE_DIR, "reply-cache.json");
const CACHE_MIN_SIM = Number(process.env.JARVIS_CACHE_MIN_SIM || 0.9);
const CACHE_MAX = Number(process.env.JARVIS_CACHE_MAX || 200);
const CACHE_TTL_MS = Number(process.env.JARVIS_CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
// Opportunistic session compaction: when a session's message count exceeds
// this, the daemon summarizes it in the background on boot (shrinks context,
// speeds the task path). Set JARVIS_COMPACT=0 to disable.
const COMPACT_MIN_MESSAGES = Number(process.env.JARVIS_COMPACT_MIN_MESSAGES || 80);
const COMPACT_ENABLED = String(process.env.JARVIS_COMPACT || "1") !== "0";

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
const MIC_SOURCE_FILE = join(STATE_DIR, "mic-source.json");

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

// ----------------------------------------------------------------- mic source
// The daemon records the desktop mic via ffmpeg + PulseAudio "default". If that
// default source is a dead/headless mic it silently captures silence. Before
// recording we therefore pick a real input source that is actually producing a
// signal (probe via volumedetect), falling back to "default". Overridable with
// JARVIS_MIC_SOURCE. Probing is cached briefly so tapping-to-record stays snappy.
const MIC_SOURCE_TTL = 30000;
let micSource = null; // resolved { name, ts }

// The persisted mic choice ("auto" | "default" | an alsa_input device name).
// Priority: JARVIS_MIC_SOURCE env > mic-source.json > "auto".
async function micSetting() {
  if (process.env.JARVIS_MIC_SOURCE) return process.env.JARVIS_MIC_SOURCE;
  try {
    const d = JSON.parse(readFileSync(MIC_SOURCE_FILE, "utf8"));
    if (d && typeof d.source === "string" && d.source) return d.source;
  } catch {}
  return "auto";
}

async function listMicSources() {
  try {
    const { stdout } = await execFileAsync("pactl", ["list", "sources", "short"], {
      timeout: 5000,
    });
    return stdout
      .trim()
      .split("\n")
      .map((l) => l.split("\t"))
      .filter((p) => p.length >= 2 && /^alsa_input\./.test(p[1]))
      .filter((p) => !p[1].includes(".monitor"))
      .map((p) => ({ name: p[1], state: p[4] || "" }));
  } catch {
    return [];
  }
}

// Capture ~1.2s and return the peak volume in dB (low = silent/quiet).
async function probeMicLevel(source) {
  const tmp = join(STATE_DIR, "mic_probe.wav");
  try {
    await execFileAsync(
      "ffmpeg",
      ["-y", "-f", "pulse", "-i", source, "-t", "1.2", "-ac", "1", "-ar", "16000", tmp],
      { timeout: 4000 }
    );
    const { stdout } = await execFileAsync(
      "ffmpeg",
      ["-hide_banner", "-i", tmp, "-af", "volumedetect", "-f", "null", "-"],
      { timeout: 5000 }
    );
    const m = stdout.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
    return m ? parseFloat(m[1]) : -200;
  } catch {
    return -200;
  }
}

async function resolveMicSource() {
  const now = Date.now();
  if (micSource && now - micSource.ts < MIC_SOURCE_TTL) return micSource.name;
  const want = await micSetting();
  let chosen = "default";
  if (want !== "auto" && want !== "default") {
    // An explicit device from env / config — probe it, but trust it if it has
    // signal (get the real name); otherwise keep the explicit device anyway.
    const db = await probeMicLevel(want);
    if (process.env.JARVIS_DEBUG) {
      console.error(`[mic] using configured ${want} (probe max=${db.toFixed(1)}dB)`);
    }
    chosen = want;
  } else if (want === "auto") {
    // Best-effort: probe candidates, prefer non-suspended inputs with signal.
    const srcs = await listMicSources();
    if (srcs.length) {
      const ordered = [
        ...srcs.filter((s) => s.state && s.state !== "SUSPENDED"),
        ...srcs.filter((s) => !s.state || s.state === "SUSPENDED"),
      ];
      for (const s of ordered) {
        const db = await probeMicLevel(s.name);
        if (process.env.JARVIS_DEBUG) {
          console.error(`[mic] auto probe ${s.name} max=${db.toFixed(1)}dB state=${s.state}`);
        }
        if (db >= -45) {
          chosen = s.name;
          break;
        }
      }
    }
  }
  micSource = { name: chosen, ts: now };
  return chosen;
}

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

// Thrown when the user cancels the in-flight generation (POST /api/abort).
// Must propagate past runAgent/runFastVoice so a cancel is a cancel — it must
// never trigger an escalation or a CLI re-run.
class GenerationCancelledError extends Error {}

// The active user-facing generation, so /api/abort can stop it (both the local
// fetch and the server-side session generation).
let currentAbort = null;

// Map an opencode tool name + input to a short, friendly activity label so
// the UI can show what the assistant is doing without technical jargon.
function truncateStr(s, n) {
  const str = String(s || "").trim().replace(/\s+/g, " ");
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

function friendlyActivity(toolName, input) {
  const name = String(toolName || "").toLowerCase();
  const q = (...keys) => {
    for (const k of keys) {
      const v = input && input[k];
      if (typeof v === "string" && v.trim()) return ` — "${truncateStr(v, 70)}"`;
    }
    return "";
  };
  const rules = [
    [/(^|_)websearch$|search_web|search_code/, () => "Searching the web" + q("query", "q")],
    [/webfetch|fetch_web/, () => "Looking at a website" + q("url")],
    [/playwright_browser/, () => "Using a browser" + q("url")],
    [/vault_search|vault_search_semantic|vault_read|vault_context|memory_search|memory_read/, () => "Reading your notes" + (q("query", "note", "topic") || q("note"))],
    [/vault_write|vault_log|memory_write/, () => "Updating your notes" + q("note", "topic")],
    [/read_text_file|read_file/, () => "Opening a file" + q("path", "file_path")],
    [/write_file|edit_file|(^|_)edit$|(^|_)write$/, () => "Editing a file" + q("path", "file_path")],
    [/search_files|directory_tree|list_directory|(^|_)glob$|(^|_)grep$/, () => "Looking through your files" + (q("path", "pattern") || q("path"))],
    [/^bash$|^exec|shell/, () => "Running a command on your computer"],
    [/^github_/, () => "Checking GitHub"],
    [/(^|_)notify$/, () => "Sending you a notification"],
    [/(^|_)say$|tts/, () => "Speaking"],
  ];
  for (const [re, fn] of rules) if (re.test(name)) return fn();
  return "Working on that";
}

// Run the prompt against the warm opencode server (no per-request process boot).
// Returns the assistant's raw text reply. When onDelta is given, incremental
// reply text is pushed to it as the model generates (via /global/event).
// Watchdog: if firstDeltaMs is set and no delta arrives in time, or if
// replyTimeoutMs is set and no reply arrives in time, the generation is
// aborted on the server (POST /session/:id/abort) and GenerationTimeoutError
// is thrown — this bounds worst-case waits instead of letting a stuck model
// hold the session for the full 120s.
async function runAgentWarm(prompt, { agent = "jarvis", sessionFile = SESSION_FILE, title = "jarvis daemon", onDelta, firstDeltaMs = 0, replyTimeoutMs = 0, onActivity } = {}) {
  const base = await spawnOcServer();
  const sid = await ensureSession(sessionFile, title);
  const ctrl = new AbortController();
  const info = { ctrl, sid, cancelled: false };
  currentAbort = info;
  const budget = onDelta ? firstDeltaMs : replyTimeoutMs;
  let gotFirst = false;
  let timedOut = false;
  let timer = null;
  let activityTimer = null;
  const seenCalls = new Set();
  let pollN = 0;
  if (onActivity) {
    // Live activity feed: opencode does not stream tool calls, but the
    // in-flight assistant message (GET /session/{id}/message) carries tool
    // parts while the step is running. Poll it and surface each new tool call
    // as a friendly progress label. Pruned after completion, so poll live.
    activityTimer = setInterval(async () => {
      try {
        const resp = await httpJson(`${base}/session/${sid}/message?limit=3`, {
          auth: OC_AUTH,
          timeoutMs: 5000,
        });
        const msgs = Array.isArray(resp) ? resp : (resp.messages || []);
        if (process.env.JARVIS_DEBUG && !pollN) {
          console.error(`[activity] msgs=${msgs.length} kinds=[${msgs.map((m) => (m.parts || []).map((p) => p.type).join("|")).join(" ; ")}]`);
        }
        pollN = (pollN + 1) % 8;
        for (const msg of msgs) {
          if (!msg || !Array.isArray(msg.parts)) continue;
          for (const part of msg.parts) {
            if (part.type !== "tool" || !part.callID || seenCalls.has(part.callID)) continue;
            const input = part.state && part.state.input;
            const hasInput = !!input && typeof input === "object" && Object.keys(input).length > 0;
            if (!hasInput) continue;
            seenCalls.add(part.callID);
            if (process.env.JARVIS_DEBUG) {
              console.error(`[activity] tool=${part.tool} input=${JSON.stringify(input).slice(0, 150)}`);
            }
            onActivity(friendlyActivity(part.tool, input));
          }
        }
      } catch (e) {
        if (process.env.JARVIS_DEBUG) console.error(`[activity] poll error: ${e.message}`);
      }
    }, 250);
  }
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
    if (info.cancelled) throw new GenerationCancelledError("generation cancelled");
    if (timedOut) throw new GenerationTimeoutError("generation exceeded its time budget");
    throw e;
  } finally {
    if (currentAbort === info) currentAbort = null;
    if (timer) clearTimeout(timer);
    if (activityTimer) clearInterval(activityTimer);
    if (unwatch) unwatch();
  }
}

// Run the jarvis agent in a persistent session; returns the raw output.
async function runAgent(prompt, onDelta, onActivity) {
  const t0 = Date.now();
  try {
    const out = await runAgentWarm(prompt, { onDelta, firstDeltaMs: FIRST_DELTA_MS, onActivity });
    if (process.env.JARVIS_DEBUG) console.error(`[runAgent] warm ok in ${Date.now() - t0}ms`);
    return out;
  } catch (e) {
    if (e instanceof GenerationTimeoutError) throw e; // don't compound the wait with a CLI fallback
    if (e instanceof GenerationCancelledError) throw e; // a cancel must not re-run
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

// True when a reply has no real content (empty, punctuation-only, or the
// generic fallback). Long tool-using turns occasionally end with a bare "..."
// — catch that so we never speak a degenerate reply.
function isDegenerateReply(s) {
  const t = normalizePlain(s);
  if (!t) return true;
  if (t === "Sorry, I did not catch that.") return true;
  return /^[\s.\u2026!?,;:\-]+$/.test(t);
}

// ----------------------------------------------------------------- fast path

// Deterministic commands answered locally — no LLM, no tools, ~instant. Kept
// intentionally narrow so they can't shadow a real request. Time/date used to
// route to the full agent (task keywords), costing 8-20s; now they're free.
function timeOfDay() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}
const DET_COMMANDS = [
  {
    re: /\b(what('?s| is) the time|what time is it|current time|tell me the time)\b/i,
    reply: () => {
      const d = new Date();
      return `It's ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
    },
  },
  {
    re: /\b(what('?s| is) the date|what day is it|today('?s)? date)\b/i,
    reply: () => {
      const d = new Date();
      return `It's ${d.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`;
    },
  },
  {
    re: /^(hi|hello|hey|hiya|yo|howdy|good morning|good afternoon|good evening)[\s!.,]*$/i,
    reply: () => `Good ${timeOfDay()}. How can I help?`,
  },
  { re: /^(thanks|thank you|thank u|thx|cheers|ty)[\s!.,]*$/i, reply: () => "You're welcome." },
  {
    re: /\b(who are you|what('?s| is) your name|introduce yourself|are you jarvis)\b/i,
    reply: () => "I'm Jarvis, your personal assistant. I can help with apps, files, the web, and your notes.",
  },
];

function matchDeterministic(text) {
  const t = text.trim();
  for (const c of DET_COMMANDS) if (c.re.test(t)) return c;
  return null;
}

// Full jarvis agent in voice mode: for task requests the assistant actually
// uses tools (web, notes, files, commands) so replies are accurate and the
// client progress feed has real steps to show. Replies keep the JSON envelope.
async function runJarvisVoice(userText, onDelta, onActivity) {
  const prompt =
    `You are Jarvis in VOICE MODE. The user said: "${userText}". ` +
    `If the request needs up-to-date information or an action, actually use a tool ` +
    `(websearch, webfetch, vault_read, memory_read, filesystem_read_text_file, or bash) ` +
    `to get it done — do not answer from memory or guess when a tool can verify. ` +
    `Once you have the answer, respond conversationally and briefly (1-3 short sentences), ` +
    `the way a voice assistant would. Output ONLY a JSON object of the form {"reply": "your spoken reply"} ` +
    `as your final message. Do NOT call "say". No markdown, no commentary in the final message.`;
  let reply = await extractReply(await runAgent(prompt, onDelta, onActivity));
  if (isDegenerateReply(reply)) {
    // The model sometimes finishes a long tool-using turn with a bare "..." and
    // no JSON envelope. The research is already in the session, so a short
    // reformat follow-up (seconds, not a full re-run) reliably recovers a reply.
    if (process.env.JARVIS_DEBUG) console.error("[voice] degenerate reply; reformatting");
    reply = await extractReply(
      await runAgent(
        `You were asked: "${userText}". Using your earlier work, reply conversationally and briefly (1-2 short sentences), as a voice assistant would. Output ONLY a JSON object of the form {"reply": "your spoken reply"}. No tools. No markdown, no commentary.`,
        onDelta,
        onActivity
      )
    );
  }
  if (isDegenerateReply(reply)) {
    if (process.env.JARVIS_DEBUG) console.error("[voice] reformat also degenerate; graceful reply");
    reply = "Sorry, I finished that but couldn't put it into words. Try asking again.";
  }
  return reply;
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
    if (isDegenerateReply(out)) {
      if (process.env.JARVIS_DEBUG) console.error("[voice] fast agent returned degenerate reply; escalating");
      return "TASK";
    }
    return out;
  } catch (e) {
    if (e instanceof GenerationCancelledError) throw e;
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

// ------------------------------------------------------- semantic reply cache

// Past chit-chat (Q -> reply) matched by embedding similarity. A hit skips the
// LLM entirely and returns the stored reply; audio is still TTS'd fresh (fast).
// Never consulted for task requests (those may have side effects and must not
// replay a cached answer). All failures degrade to a miss — the cache can never
// make a turn fail.
let replyCache = [];
let cacheSaveTimer = null;
try {
  replyCache = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  if (!Array.isArray(replyCache)) replyCache = [];
} catch {
  replyCache = [];
}

async function embedText(text) {
  try {
    await ensureSpeech();
    const resp = await fetch(`http://127.0.0.1:${SPEECH_PORT}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const d = await resp.json();
    return Array.isArray(d.embed) ? d.embed : null;
  } catch {
    return null;
  }
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

let lastEmbedded = null;
async function cacheLookup(text) {
  lastEmbedded = await embedText(text);
  if (!lastEmbedded || replyCache.length === 0) return null;
  let best = null;
  let bestSim = 0;
  const now = Date.now();
  for (const e of replyCache) {
    if (!e.emb) continue;
    if (now - (e.ts || 0) > CACHE_TTL_MS) continue; // skip stale entries
    const sim = cosine(lastEmbedded, e.emb);
    if (sim > bestSim) {
      bestSim = sim;
      best = e;
    }
  }
  if (best && bestSim >= CACHE_MIN_SIM) {
    best.hits = (best.hits || 0) + 1;
    best.ts = Date.now();
    scheduleCacheSave();
    if (process.env.JARVIS_DEBUG) {
      console.error(`[cache] HIT sim=${bestSim.toFixed(3)} hits=${best.hits} q="${text}"`);
    }
    return best;
  }
  return null;
}

function scheduleCacheSave() {
  if (cacheSaveTimer) clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null;
    try {
      writeFileSync(CACHE_FILE, JSON.stringify(replyCache), { mode: 0o600 });
    } catch {}
  }, 2000);
}

async function cacheStore(text, reply) {
  const emb = await embedText(text);
  if (!emb) return;
  replyCache.push({ q: text, reply, emb, ts: Date.now(), hits: 1 });
  if (replyCache.length > CACHE_MAX) {
    replyCache.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    replyCache = replyCache.slice(-CACHE_MAX);
  }
  scheduleCacheSave();
  if (process.env.JARVIS_DEBUG) console.error(`[cache] store (${replyCache.length} entries)`);
}

// Turn a user utterance into a reply + piper audio. Routes:
//   1. deterministic commands  -> answered locally (instant, no LLM)
//   2. task requests           -> full jarvis agent (with streaming)
//   3. chit-chat               -> semantic reply cache first, else lean
//                                jarvis-voice agent (TASK self-escalation)
async function handleUtterance(userText, onDelta, onActivity) {
  const t0 = Date.now();
  let agent = "jarvis";
  let reply;
  const det = matchDeterministic(userText);
  if (det) {
    agent = "det";
    reply = det.reply();
  } else if (isTaskRequest(userText)) {
    reply = await runJarvisVoice(userText, onDelta, onActivity);
  } else {
    const cached = await cacheLookup(userText);
    if (cached) {
      agent = "cache";
      reply = cached.reply;
    } else {
      const fast = await runFastVoice(userText);
      if (isTaskEscalation(fast)) {
        reply = await runJarvisVoice(userText, onDelta, onActivity);
      } else {
        agent = "jarvis-voice";
        reply = fast;
        if (fast !== "Sorry, I got stuck for a moment. Give me a couple of seconds and ask again.") {
          cacheStore(userText, fast); // fire-and-forget; failures degrade to a miss
        }
      }
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
// Also relays the live activity feed (friendly "what the assistant is doing"
// labels) as {type:"activity"} events.
function handleUtteranceStream(userText, send) {
  let acc = "";
  return handleUtterance(
    userText,
    (d) => {
      acc += d;
      send({ type: "delta", text: acc });
    },
    (activity) => send({ type: "activity", activity })
  );
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

// Opportunistic background compaction: if a session has accumulated a large
// history, summarize it (opencode's built-in compaction) to shrink the context
// window and cut per-request latency on the task path. Runs only at boot, after
// warming, and is disabled via JARVIS_COMPACT=0.
async function countSessionMessages(sid) {
  const base = await spawnOcServer();
  let count = 0;
  let cursor = null;
  for (let i = 0; i < 50; i++) {
    const url = `${base}/session/${sid}/message?limit=100${cursor ? `&before=${cursor}` : ""}`;
    try {
      const resp = await fetch(url, {
        headers: { Authorization: OC_AUTH },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) throw new Error(`http ${resp.status}`);
      const items = await resp.json();
      if (!Array.isArray(items)) return count;
      count += items.length;
      const next = resp.headers.get("x-next-cursor");
      if (!next || items.length === 0) return count;
      cursor = next;
    } catch {
      return count;
    }
  }
  return count;
}

async function maybeCompactSession(sessionFile, title) {
  if (!COMPACT_ENABLED) return;
  const base = await spawnOcServer();
  const sid = await ensureSession(sessionFile, title);
  let count;
  try {
    count = await countSessionMessages(sid);
  } catch {
    return;
  }
  if (count < COMPACT_MIN_MESSAGES) {
    if (process.env.JARVIS_DEBUG) console.error(`[compact] ${title}: ${count} msgs, skip`);
    return;
  }
  try {
    const info = await httpJson(`${base}/session/${sid}`, { auth: OC_AUTH, timeoutMs: 15000 });
    const model = info && info.model ? info.model : {};
    const providerID = model.providerID || "opencode";
    const modelID = model.id || "deepseek-v4-flash-free";
    if (process.env.JARVIS_DEBUG) {
      console.error(`[compact] ${title}: ${count} msgs -> summarizing with ${providerID}/${modelID}`);
    }
    await httpJson(`${base}/session/${sid}/summarize`, {
      method: "POST",
      auth: OC_AUTH,
      body: { providerID, modelID, auto: false },
      timeoutMs: 300000,
    });
    if (process.env.JARVIS_DEBUG) console.error(`[compact] ${title}: done`);
  } catch (e) {
    if (process.env.JARVIS_DEBUG) console.error(`[compact] ${title} failed: ${e.message}`);
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

// Cancel the in-flight generation (user hit Stop / Esc). Stops both the local
// fetch and the server-side session generation so the next turn starts clean.
app.post("/api/abort", auth, async (req, res) => {
  const cur = currentAbort;
  if (!cur) return res.json({ aborted: false });
  cur.cancelled = true;
  cur.ctrl.abort();
  try {
    const base = await spawnOcServer();
    await httpJson(`${base}/session/${cur.sid}/abort`, {
      method: "POST",
      auth: OC_AUTH,
      timeoutMs: 10000,
    });
  } catch {}
  if (process.env.JARVIS_DEBUG) console.error("[abort] cancelled in-flight generation");
  res.json({ aborted: true });
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
// List selectable mic inputs and the current choice (for the widget dropdown).
app.get("/api/mic/sources", auth, async (req, res) => {
  const srcs = await listMicSources();
  let setting = "auto";
  let current = "default";
  try {
    setting = await micSetting();
    current = await resolveMicSource();
  } catch {}
  res.json({
    current,
    setting,
    sources: [{ name: "auto", label: "Auto detect", state: "" }, { name: "default", label: "Pulse default", state: "" }].concat(
      srcs.map((s) => ({ name: s.name, label: s.name.replace(/^alsa_input\./, ""), state: s.state }))
    ),
  });
});

// Change which mic the daemon records from (runtime, no restart needed).
app.post("/api/mic/source", auth, async (req, res) => {
  const { source } = req.body || {};
  if (typeof source !== "string" || !source) {
    return res.status(400).json({ error: "source required" });
  }
  const srcs = await listMicSources();
  const known =
    source === "auto" ||
    source === "default" ||
    srcs.some((s) => s.name === source);
  if (!known) return res.status(400).json({ error: "unknown source" });
  try {
    writeFileSync(MIC_SOURCE_FILE, JSON.stringify({ source, ts: Date.now() }), {
      mode: 0o600,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  micSource = null; // drop the cached resolved device
  res.json({ setting: source });
});

app.post("/api/mic/start", auth, async (req, res) => {
  if (micProc) return res.status(409).json({ error: "already recording" });
  let src = "default";
  try {
    src = await resolveMicSource();
  } catch {}
  if (process.env.JARVIS_DEBUG) console.error(`[mic] capturing via "${src}"`);
  micProc = spawn(
    "ffmpeg",
    ["-y", "-f", "pulse", "-i", src, "-af", "volume=8dB", "-ar", "16000", "-ac", "1", MIC_FILE],
    { stdio: "ignore" }
  );
  micProc.on("error", () => {
    micProc = null;
  });
  micProc.on("exit", () => {
    if (micTimer) {
      clearTimeout(micTimer);
      micTimer = null;
    }
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
    if (e instanceof GenerationCancelledError) return send({ type: "cancelled" });
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
    if (e instanceof GenerationCancelledError) return send({ type: "cancelled" });
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
      maybeCompactSession(SESSION_FILE, "jarvis daemon");
      maybeCompactSession(VOICE_SESSION_FILE, VOICE_TITLE);
    })
    .catch((e) => console.error(`[warm] opencode serve failed: ${e.message}`));
});
