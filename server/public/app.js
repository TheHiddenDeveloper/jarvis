const mic = document.getElementById("mic");
const hint = document.getElementById("hint");
const statusEl = document.getElementById("status");
const youEl = document.getElementById("you");
const logEl = document.getElementById("log");
const textbox = document.getElementById("textbox");
const sendBtn = document.getElementById("send");
const stopBtn = document.getElementById("stop");
const winMin = document.getElementById("winMin");
const winClose = document.getElementById("winClose");
const clearBtn = document.getElementById("clearLog");

const tokenModal = document.getElementById("tokenModal");
const tokenInput = document.getElementById("tokenInput");
const tokenSave = document.getElementById("tokenSave");

const TOKEN_KEY = "jarvis_token";
const LOG_KEY = "jarvis_log";
const HISTORY_MAX = 400;
const IS_LOCAL = location.hostname === "127.0.0.1" || location.hostname === "localhost";
const TAURI = window.__TAURI__;

let token = localStorage.getItem(TOKEN_KEY) || "";
let recorder = null;
let stream = null;
let chunks = [];
let recording = false;

let busy = false;
let stopRequested = false;
let activeReader = null;

// Live "what the assistant is doing" state while a turn is running.
let liveMsg = null;        // in-progress .msg element in the log
let liveThink = null;      // { steps: [], raw: "" }

// Restore the persisted conversation (text only — audio stays ephemeral).
let history = [];
try {
  const saved = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
  if (Array.isArray(saved)) {
    history = saved.filter(
      (m) => m && (m.who === "user" || m.who === "jarvis") && typeof m.text === "string"
    );
  }
} catch {}
history.forEach((m) => renderLog(m));
updateClearBtn();

// Window controls are only wired when running inside the Tauri webview.
if (TAURI) document.body.classList.add("has-tauri");

let chimeAudio = null;

function playChime() {
  try {
    if (chimeAudio) chimeAudio.pause();
    chimeAudio = new Audio("/chime.wav?t=" + Date.now());
    chimeAudio.volume = 0.8;
    chimeAudio.play().catch(() => {});
  } catch {}
}

function setStatus(name) {
  statusEl.textContent = name;
  statusEl.className = "status";
  if (name !== "idle") statusEl.classList.add(name);
}

function setMicState(state) {
  mic.className = "mic";
  if (state) mic.classList.add(state);
}

function scrollToBottom() {
  logEl.scrollTop = logEl.scrollHeight;
}

function setThinking(text) {
  setMicState("thinking");
  setStatus("thinking");
  youEl.textContent = text;
  youEl.classList.add("thinking");
  stopBtn.classList.remove("hidden");
}

function idleUI() {
  youEl.classList.remove("thinking");
  youEl.textContent = "";
  setMicState("");
  setStatus("idle");
  hint.textContent = "Tap to talk";
  stopBtn.classList.add("hidden");
  endLive();
}

function resetAfterStop() {
  youEl.classList.remove("thinking");
  youEl.textContent = "Stopped";
  setMicState("");
  setStatus("idle");
  hint.textContent = "Tap to talk";
  stopBtn.classList.add("hidden");
  endLive();
}

// ------------------------------------------------------- thinking component
// The raw model reasoning and the tool actions never leak into the chat
// bubble. While a turn runs we show a live "Thinking" panel in the log; the
// actions stream in as a dot-sequence and the raw text fills a collapsible
// <pre>. When the reply is ready it is rendered (markdown) into the message.

function startLive() {
  endLive();
  liveMsg = document.createElement("div");
  liveMsg.className = "msg jarvis live";
  liveMsg.innerHTML =
    '<div class="think">' +
    '<button class="think-head active" type="button">' +
    '<span class="sp"></span><span class="tl">Thinking</span><span class="caret">▾</span>' +
    "</button>" +
    '<div class="think-body">' +
    '<div class="think-steps"></div>' +
    '<pre class="think-raw"></pre>' +
    "</div></div>";
  liveMsg.querySelector(".think-head").addEventListener("click", () => {
    const body = liveMsg.querySelector(".think-body");
    body.classList.toggle("collapsed");
    liveMsg.querySelector(".think-head").classList.toggle("open");
  });
  logEl.appendChild(liveMsg);
  liveThink = { steps: [], raw: "" };
  scrollToBottom();
}

function addLiveStep(label) {
  if (!liveMsg) return;
  liveThink.steps.push(label);
  const step = document.createElement("span");
  step.className = "step";
  step.innerHTML = '<i class="dot"></i><span></span>';
  step.lastChild.textContent = label;
  liveMsg.querySelector(".think-steps").appendChild(step);
  scrollToBottom();
}

function setLiveRaw(text) {
  if (!liveMsg) return;
  liveThink.raw = text;
  liveMsg.querySelector(".think-raw").textContent = text;
  scrollToBottom();
}

function endLive() {
  if (liveMsg) {
    liveMsg.remove();
    liveMsg = null;
  }
  liveThink = null;
}

// The finished thinking panel (kept collapsed so the chat stays clean).
function buildThinkBlock(think) {
  const wrap = document.createElement("div");
  wrap.className = "think";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "think-head";
  head.innerHTML =
    '<span class="sp"></span><span class="tl">Thinking</span><span class="caret">▾</span>';
  const body = document.createElement("div");
  body.className = "think-body collapsed";
  if (think && think.steps && think.steps.length) {
    const steps = document.createElement("div");
    steps.className = "think-steps";
    for (const s of think.steps) {
      const step = document.createElement("span");
      step.className = "step";
      step.innerHTML = '<i class="dot"></i><span></span>';
      step.lastChild.textContent = s;
      steps.appendChild(step);
    }
    body.appendChild(steps);
  }
  if (think && think.raw) {
    const raw = document.createElement("pre");
    raw.className = "think-raw";
    raw.textContent = think.raw;
    body.appendChild(raw);
  }
  wrap.appendChild(head);
  wrap.appendChild(body);
  head.addEventListener("click", () => {
    body.classList.toggle("collapsed");
    head.classList.toggle("open");
  });
  return wrap;
}

// -------------------------------------------------------- markdown renderer
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_]+)_/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );
  return s;
}

function md(src) {
  src = String(src || "").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  let h = "";
  let list = null;
  let para = [];
  const closeList = () => {
    if (list) {
      h += "<" + list.t + ">" + list.items.map((x) => "<li>" + x + "</li>").join("") + "</" + list.t + ">";
      list = null;
    }
  };
  const flushPara = () => {
    if (para.length) {
      h += "<p>" + para.join("<br>") + "</p>";
      para = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const t = l.trim();
    if (/^```/.test(t)) {
      flushPara(); closeList();
      const lang = (t.match(/^```(\w*)/) || [])[1] || "";
      i++;
      const buf = [];
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++;
      h += '<pre><code class="lang-' + esc(lang) + '">' + esc(buf.join("\n")) + "</code></pre>";
      continue;
    }
    if (!t) { flushPara(); closeList(); i++; continue; }
    const hd = l.match(/^(#{1,6})\s+(.*)$/);
    if (hd) { flushPara(); closeList(); h += "<h" + (hd[1].length + 1) + ">" + inline(hd[2]) + "</h" + (hd[1].length + 1) + ">"; i++; continue; }
    const ul = l.match(/^\s*[-*+]\s+(.*)$/);
    const ol = !ul && l.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const t2 = ul ? "ul" : "ol";
      if (list && list.t !== t2) closeList();
      if (!list) list = { t: t2, items: [] };
      list.items.push(inline((ul || ol)[1]));
      i++;
      continue;
    }
    const bq = l.match(/^\s*>\s?(.*)$/);
    if (bq) {
      flushPara(); closeList();
      const b = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*>\s?(.*)$/);
        if (!m) break;
        b.push(m[1]); i++;
      }
      h += "<blockquote>" + inline(b.join(" ")) + "</blockquote>";
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { flushPara(); closeList(); h += "<hr>"; i++; continue; }
    closeList();
    para.push(inline(l));
    i++;
  }
  flushPara();
  closeList();
  return h;
}

// ------------------------------------------------------------ message log
function renderLog(entry) {
  const div = document.createElement("div");
  div.className = "msg " + (entry.who || "jarvis");
  if (entry.who === "user") {
    div.textContent = entry.text;
  } else {
    if (entry.thinking && (entry.thinking.steps?.length || entry.thinking.raw)) {
      div.appendChild(buildThinkBlock(entry.thinking));
    }
    const reply = document.createElement("div");
    reply.className = "md";
    reply.innerHTML = md(entry.text);
    div.appendChild(reply);
  }
  logEl.appendChild(div);
  scrollToBottom();
}

function updateClearBtn() {
  if (history.length) clearBtn.classList.remove("hidden");
  else clearBtn.classList.add("hidden");
}

function persistLog() {
  if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(history));
  } catch {}
  updateClearBtn();
}

function addMsg(text, who, thinking) {
  const entry = { who, text, ts: Date.now() };
  if (thinking && (thinking.steps?.length || thinking.raw)) entry.thinking = thinking;
  history.push(entry);
  persistLog();
  renderLog(entry);
}

function clearLog() {
  history = [];
  try {
    localStorage.removeItem(LOG_KEY);
  } catch {}
  logEl.innerHTML = "";
  updateClearBtn();
}

clearBtn.addEventListener("click", clearLog);

// ----------------------------------------------------------- core handlers
// Cancel the in-flight generation: tell the daemon to abort (it closes the SSE
// stream with a {type:"cancelled"} event), and force-close the local stream if
// the daemon never responds.
async function stopCurrent() {
  if (!busy) return;
  stopRequested = true;
  hint.textContent = "Stopping…";
  setStatus("idle");
  stopBtn.classList.add("hidden");
  try {
    const r = await fetch("/api/abort", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 401) return showToken();
    await r.json();
  } catch {}
  setTimeout(() => {
    if (activeReader && stopRequested) activeReader.cancel();
  }, 1500);
}

function showToken() {
  tokenModal.classList.remove("hidden");
  tokenInput.focus();
}

tokenSave.addEventListener("click", () => {
  token = tokenInput.value.trim();
  localStorage.setItem(TOKEN_KEY, token);
  tokenModal.classList.add("hidden");
  tokenInput.value = "";
});

async function autoToken() {
  if (token) return true;
  if (!IS_LOCAL) return false;
  try {
    const r = await fetch("/api/token");
    if (r.ok) {
      const d = await r.json();
      if (d.token) {
        token = d.token;
        localStorage.setItem(TOKEN_KEY, token);
        return true;
      }
    }
  } catch {}
  return false;
}

// The widget always runs online against the local daemon; a service worker
// only risks serving stale code. Unregister it on loopback.
if (IS_LOCAL && "serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) =>
    regs.forEach((r) => r.unregister())
  );
}

async function renderReply(userText, data) {
  const thinking = liveThink;
  // The raw stream is the model's reasoning text plus a trailing JSON carrier
  // like {"reply":"..."}. Strip that envelope so the thinking panel shows only
  // the reasoning — never the structured reply.
  if (thinking && thinking.raw) {
    const idx = thinking.raw.search(/{"reply"\s*:/);
    if (idx > 0) thinking.raw = thinking.raw.slice(0, idx).trim();
  }
  endLive();
  addMsg(userText, "user");
  addMsg(data.reply, "jarvis", thinking);
  youEl.classList.remove("thinking");
  youEl.textContent = "";
  if (!data.audioB64) {
    // TTS failed on the daemon side: show the text reply, skip speech.
    setMicState("");
    setStatus("idle");
    hint.textContent = "Tap to talk";
    stopBtn.classList.add("hidden");
    return;
  }
  setMicState("speaking");
  setStatus("speaking");
  const audio = new Audio(`data:audio/wav;base64,${data.audioB64}`);
  audio.onended = () => {
    setMicState("");
    setStatus("idle");
    hint.textContent = "Tap to talk";
  };
  await audio.play();
}

// POST an utterance and read the streaming reply. The daemon answers as SSE:
//   {type:"user"}     -> the recognized transcript (audio input)
//   {type:"delta"}    -> raw assistant text; feeds the collapsible thinking
//   {type:"activity"} -> a friendly tool-action label (dot-sequence step)
//   {type:"done"}     -> final {reply, audioB64} once the reply is complete
//   {type:"cancelled}-> user stopped the generation
async function streamPost(url, body) {
  const opts = {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  if (resp.status === 401) return { unauthorized: true };
  if (!resp.ok) {
    let msg = resp.statusText;
    try {
      msg = (await resp.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  activeReader = reader;
  let buf = "";
  let data = null;
  try {
    for (;;) {
      let result;
      try {
        result = await reader.read();
      } catch (e) {
        if (stopRequested) return { cancelled: true };
        throw e;
      }
      const { value, done } = result;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
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
        if (ev.type === "user") {
          data = data || {};
          data.user = ev.text;
        } else if (ev.type === "delta") {
          setLiveRaw(ev.text);
        } else if (ev.type === "done") {
          data = { ...data, ...ev };
        } else if (ev.type === "activity") {
          addLiveStep(ev.activity);
        } else if (ev.type === "cancelled") {
          data = { cancelled: true };
        } else if (ev.type === "error") {
          throw new Error(ev.message);
        }
      }
    }
  } finally {
    activeReader = null;
  }
  if (data && data.cancelled) return data;
  if (stopRequested) return { cancelled: true };
  if (!data || !data.reply) throw new Error("stream ended without a reply");
  return data;
}

async function send(userText, listenLabel) {
  busy = true;
  setThinking(listenLabel);
  playChime();
  startLive();
  try {
    const data = await streamPost("/api/ask", { text: userText });
    if (data.unauthorized) return showToken();
    if (data.cancelled) return resetAfterStop();
    await renderReply(userText, data);
  } catch (e) {
    if (stopRequested) return resetAfterStop();
    youEl.textContent = `Error: ${e.message}`;
    youEl.classList.remove("thinking");
    setMicState("");
    setStatus("idle");
    stopBtn.classList.add("hidden");
    endLive();
  } finally {
    busy = false;
    stopRequested = false;
  }
}

async function sendAudio() {
  busy = true;
  setThinking("Listening to you…");
  playChime();
  try {
    const blob = new Blob(chunks, { type: recorder.mimeType });
    const b64 = await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result.split(",")[1]);
      fr.readAsDataURL(blob);
    });
    startLive();
    const data = await streamPost("/api/ask", { audioB64: b64, mime: recorder.mimeType });
    if (data.unauthorized) return showToken();
    if (data.cancelled) return resetAfterStop();
    await renderReply(data.user, data);
  } catch (e) {
    if (stopRequested) return resetAfterStop();
    youEl.textContent = `Error: ${e.message}`;
    youEl.classList.remove("thinking");
    setMicState("");
    setStatus("idle");
    stopBtn.classList.add("hidden");
    endLive();
  } finally {
    busy = false;
    stopRequested = false;
  }
}

async function sendHostAudio() {
  busy = true;
  setThinking("Listening to you…");
  playChime();
  try {
    startLive();
    const data = await streamPost("/api/mic/stop", null);
    if (data.unauthorized) return showToken();
    if (data.cancelled) return resetAfterStop();
    await renderReply(data.user, data);
  } catch (e) {
    if (stopRequested) return resetAfterStop();
    youEl.textContent = `Error: ${e.message}`;
    youEl.classList.remove("thinking");
    setMicState("");
    setStatus("idle");
    stopBtn.classList.add("hidden");
    endLive();
  } finally {
    busy = false;
    stopRequested = false;
  }
}

async function startRecording() {
  if (IS_LOCAL) {
    try {
      const r = await fetch("/api/mic/start", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.status === 401) return showToken();
      if (!r.ok) throw new Error((await r.json()).error || "record start failed");
      recording = true;
      setMicState("recording");
      setStatus("recording");
      hint.textContent = "Tap to stop";
      setTimeout(() => {
        if (recording) stopRecording();
      }, 60000);
    } catch (e) {
      youEl.textContent = `Mic error: ${e.message}`;
    }
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream);
    chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.start();
    recording = true;
    setMicState("recording");
    setStatus("recording");
    hint.textContent = "Tap to stop";
    setTimeout(() => {
      if (recording) stopRecording();
    }, 30000);
  } catch (e) {
    youEl.textContent = `Mic error: ${e.message}`;
  }
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  if (IS_LOCAL) return sendHostAudio();
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      sendAudio();
    };
  }
}

mic.addEventListener("click", () => {
  if (recording) stopRecording();
  else startRecording();
});

stopBtn.addEventListener("click", () => stopCurrent());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && busy) stopCurrent();
});

sendBtn.addEventListener("click", () => {
  const t = textbox.value.trim();
  if (t) {
    textbox.value = "";
    send(t, "Thinking…");
  }
});
textbox.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendBtn.click();
});

// Window controls (widget only). The web layer runs on the daemon origin, so
// these only exist because the widget exposes window.__TAURI__.
if (TAURI) {
  try {
    const win = TAURI.window.getCurrentWindow();
    winMin.addEventListener("click", () => win.minimize());
    winClose.addEventListener("click", () => win.close());
  } catch {}
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

autoToken().then((ok) => {
  if (!ok && !token) showToken();
});