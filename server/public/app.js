const mic = document.getElementById("mic");
const hint = document.getElementById("hint");
const statusEl = document.getElementById("status");
const youEl = document.getElementById("you");
const logEl = document.getElementById("log");
const textbox = document.getElementById("textbox");
const sendBtn = document.getElementById("send");

const tokenModal = document.getElementById("tokenModal");
const tokenInput = document.getElementById("tokenInput");
const tokenSave = document.getElementById("tokenSave");

const TOKEN_KEY = "jarvis_token";
const IS_LOCAL = location.hostname === "127.0.0.1" || location.hostname === "localhost";
let token = localStorage.getItem(TOKEN_KEY) || "";
let recorder = null;
let stream = null;
let chunks = [];
let recording = false;

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
  addMsg(userText, "user");
  addMsg(data.reply, "jarvis");
  setMicState("speaking");
  setStatus("speaking");
  const audio = new Audio(`data:audio/wav;base64,${data.audioB64}`);
  audio.onended = () => {
    setMicState("");
    setStatus("idle");
    hint.textContent = "Tap to talk";
  };
  youEl.classList.remove("thinking");
  youEl.textContent = "";
  await audio.play();
}

// POST an utterance and read the streaming reply. The daemon answers as SSE:
//   {type:"user"}  -> the recognized transcript (audio input)
//   {type:"delta"} -> incremental assistant text, rendered live
//   {type:"done"}  -> final {reply, audioB64} once the reply is complete
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
  let buf = "";
  let data = null;
  for (;;) {
    const { value, done } = await reader.read();
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
        youEl.textContent = ev.text;
      } else if (ev.type === "done") {
        data = { ...data, ...ev };
      } else if (ev.type === "error") {
        throw new Error(ev.message);
      }
    }
  }
  if (!data || !data.reply) throw new Error("stream ended without a reply");
  return data;
}

async function ask(userText) {
  setMicState("thinking");
  setStatus("thinking");
  youEl.textContent = "Thinking…";
  youEl.classList.add("thinking");
  playChime();
  try {
    const data = await streamPost("/api/ask", { text: userText });
    if (data.unauthorized) return showToken();
    await renderReply(userText, data);
  } catch (e) {
    youEl.textContent = `Error: ${e.message}`;
    youEl.classList.remove("thinking");
    setMicState("");
    setStatus("idle");
  }
}

async function sendAudio() {
  setMicState("thinking");
  setStatus("thinking");
  youEl.textContent = "Listening to you…";
  youEl.classList.add("thinking");
  playChime();
  try {
    const blob = new Blob(chunks, { type: recorder.mimeType });
    const b64 = await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result.split(",")[1]);
      fr.readAsDataURL(blob);
    });
    const data = await streamPost("/api/ask", { audioB64: b64, mime: recorder.mimeType });
    if (data.unauthorized) return showToken();
    await renderReply(data.user, data);
  } catch (e) {
    youEl.textContent = `Error: ${e.message}`;
    youEl.classList.remove("thinking");
    setMicState("");
    setStatus("idle");
  }
}

async function sendHostAudio() {
  setMicState("thinking");
  setStatus("thinking");
  youEl.textContent = "Listening to you…";
  youEl.classList.add("thinking");
  playChime();
  try {
    const data = await streamPost("/api/mic/stop", null);
    if (data.unauthorized) return showToken();
    await renderReply(data.user, data);
  } catch (e) {
    youEl.textContent = `Error: ${e.message}`;
    youEl.classList.remove("thinking");
    setMicState("");
    setStatus("idle");
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

sendBtn.addEventListener("click", () => {
  const t = textbox.value.trim();
  if (t) {
    textbox.value = "";
    ask(t);
  }
});
textbox.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendBtn.click();
});

function addMsg(text, who) {
  const div = document.createElement("div");
  div.className = `msg ${who}`;
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

autoToken().then((ok) => {
  if (!ok && !token) showToken();
});
