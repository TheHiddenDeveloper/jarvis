import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const JARVIS_DIR = join(HOME, "jarvis");
const MEMORY_DIR = join(JARVIS_DIR, "memory");
const SCREENSHOT_DIR = join(JARVIS_DIR, ".screenshots");
const ENV_FILE = join(JARVIS_DIR, ".env");

mkdirSync(MEMORY_DIR, { recursive: true });
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const server = new McpServer({ name: "jarvis-tools", version: "0.1.0" });

function loadEnv() {
  if (!existsSync(ENV_FILE)) return {};
  const env = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !m[1].startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

function has(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const uid = process.getuid?.() ?? "";
const graphicalEnv = {
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
  WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || process.env.DISPLAY || "wayland-0",
  DBUS_SESSION_BUS_ADDRESS:
    process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus`,
  ...process.env,
};

function run(cmd, args = [], opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    timeout: 20000,
    env: graphicalEnv,
    ...opts,
  });
}

// ---------------------------------------------------------------- memory
server.tool(
  "memory_read",
  "Read a topic file from Jarvis's long-term memory (~/jarvis/memory/<topic>.md).",
  { topic: z.string().describe("Topic name, e.g. 'preferences' or 'projects'") },
  async ({ topic }) => {
    const safe = topic.replace(/[^a-z0-9-]/gi, "");
    const path = join(MEMORY_DIR, `${safe}.md`);
    if (!existsSync(path)) {
      return { content: [{ type: "text", text: `No memory topic "${safe}".` }] };
    }
    return { content: [{ type: "text", text: readFileSync(path, "utf8") }] };
  }
);

server.tool(
  "memory_write",
  "Append a dated entry to a topic file in Jarvis's long-term memory.",
  {
    topic: z.string().describe("Topic name, e.g. 'preferences'"),
    content: z.string().describe("Content to append (one or a few lines). Secrets go in ~/jarvis/.env, never here."),
  },
  async ({ topic, content }) => {
    const safe = topic.replace(/[^a-z0-9-]/gi, "");
    const path = join(MEMORY_DIR, `${safe}.md`);
    const date = new Date().toISOString().slice(0, 10);
    appendFileSync(path, `\n- [${date}] ${content.trim()}\n`);
    return { content: [{ type: "text", text: `Appended to memory/${safe}.md` }] };
  }
);

server.tool(
  "memory_search",
  "Full-text search across all Jarvis memory topic files.",
  { query: z.string().describe("Search text") },
  async ({ query }) => {
    if (!has("rg")) {
      return { content: [{ type: "text", text: "rg not installed; cannot search." }] };
    }
    try {
      const out = run("rg", ["-il", query, MEMORY_DIR]);
      return { content: [{ type: "text", text: out || "No matches." }] };
    } catch {
      return { content: [{ type: "text", text: "No matches." }] };
    }
  }
);

// ---------------------------------------------------------------- system
server.tool(
  "system_info",
  "Report OS, session type, and availability of automation tools.",
  {},
  async () => {
    const checks = ["wtype", "grim", "slurp", "tesseract", "wl-copy", "wl-paste", "notify-send", "espeak-ng", "ffmpeg", "ntfy"];
    const info = checks.map((c) => `${c}=${has(c) ? "yes" : "no"}`).join("\n");
    const os = run("bash", ["-c", "uname -a"], { stdio: "pipe" }).trim();
    return { content: [{ type: "text", text: `OS: ${os}\nSession: ${process.env.XDG_SESSION_TYPE ?? "?"}\nTools:\n${info}` }] };
  }
);

server.tool(
  "open_app",
  "Launch an application by name (uses kde-open / gtk-launch / flatpak).",
  { app: z.string().describe("Application name, e.g. 'brave', 'obsidian', 'kate'") },
  async ({ app }) => {
    const cmds = [
      ["kde-open", app],
      ["gtk-launch", app],
      ["flatpak", "run", app],
    ];
    for (const [cmd, ...args] of cmds) {
      if (has(cmd)) {
        try {
          execFileSync(cmd, args, { stdio: "ignore", timeout: 10000 });
          return { content: [{ type: "text", text: `Launched ${app} via ${cmd}.` }] };
        } catch {
          /* try next */
        }
      }
    }
    return { content: [{ type: "text", text: `Could not launch "${app}".` }] };
  }
);

// ---------------------------------------------------------------- desktop
server.tool(
  "type_text",
  "Type text into the focused window (Wayland: wtype).",
  { text: z.string().describe("Text to type") },
  async ({ text }) => {
    if (!has("wtype")) return { content: [{ type: "text", text: "wtype not installed." }] };
    run("wtype", ["--", text]);
    return { content: [{ type: "text", text: `Typed ${text.length} chars.` }] };
  }
);

server.tool(
  "press_key",
  "Send a keyboard shortcut to the focused window, e.g. 'ctrl+c', 'Return', 'alt+Tab'.",
  { key: z.string().describe("Key combination, e.g. 'ctrl+c' or 'Return'") },
  async ({ key }) => {
    if (!has("wtype")) return { content: [{ type: "text", text: "wtype not installed." }] };
    run("wtype", ["-k", key]);
    return { content: [{ type: "text", text: `Pressed ${key}.` }] };
  }
);

server.tool(
  "mouse_move",
  "Move the mouse pointer to absolute screen coordinates (ydotool). Needs the ydotool daemon running.",
  { x: z.number().describe("X coordinate"), y: z.number().describe("Y coordinate") },
  async ({ x, y }) => {
    if (!has("ydotool")) return { content: [{ type: "text", text: "ydotool not installed." }] };
    run("ydotool", ["mousemove", "--absolute", "--x", String(x), "--y", String(y)]);
    return { content: [{ type: "text", text: `Moved pointer to (${x}, ${y}).` }] };
  }
);

server.tool(
  "mouse_click",
  "Send a mouse click (ydotool). Buttons: left, right, middle.",
  {
    button: z.enum(["left", "right", "middle"]).describe("Which button").default("left"),
    count: z.number().int().describe("Number of clicks").default(1),
  },
  async ({ button, count }) => {
    if (!has("ydotool")) return { content: [{ type: "text", text: "ydotool not installed." }] };
    const codes = { left: "0xC0", right: "0xC1", middle: "0xC2" };
    run("ydotool", ["click", codes[button], String(count)]);
    return { content: [{ type: "text", text: `Clicked ${button} x${count}.` }] };
  }
);

server.tool(
  "screenshot",
  "Capture the screen (full or region). On KDE uses Spectacle (native); grim as fallback. Optionally run OCR on it with tesseract. Returns the saved image path and any OCR text.",
  {
    region: z.boolean().describe("If true, capture a rectangular region (interactive selection on KDE; slurp on other compositors). Default: full screen.").optional(),
    ocr: z.boolean().describe("Run OCR on the capture. Default: false.").optional(),
  },
  async ({ region = false, ocr = false }) => {
    const file = join(SCREENSHOT_DIR, `shot-${Date.now()}.png`);
    let ok = false;
    if (has("spectacle")) {
      const args = ["-b", "-n", "-o", file];
      if (region) args.unshift("-r");
      try {
        run("spectacle", args);
        ok = true;
      } catch (e) {
        ok = false;
      }
    }
    if (!ok && has("grim")) {
      try {
        if (region && has("slurp")) {
          const area = run("slurp").trim();
          run("grim", ["-g", area, file]);
        } else {
          run("grim", [file]);
        }
        ok = true;
      } catch (e) {
        ok = false;
      }
    }
    if (!ok) return { content: [{ type: "text", text: "Screenshot failed: neither Spectacle nor grim could capture (compositor may not support screen capture protocol)." }] };
    let text = "";
    if (ocr) {
      if (!has("tesseract")) {
        text = "(tesseract not installed)";
      } else {
        try {
          text = run("tesseract", [file, "stdout"]).trim();
        } catch (e) {
          text = `(OCR failed: ${e.message})`;
        }
      }
    }
    return { content: [{ type: "text", text: `Saved: ${file}\n${ocr ? `OCR:\n${text}` : ""}` }] };
  }
);

server.tool(
  "ocr_image",
  "Run OCR on an existing image file with tesseract.",
  { path: z.string().describe("Absolute path to the image") },
  async ({ path }) => {
    if (!has("tesseract")) return { content: [{ type: "text", text: "tesseract not installed." }] };
    try {
      const text = run("tesseract", [path, "stdout"]).trim();
      return { content: [{ type: "text", text: text || "(no text found)" }] };
    } catch (e) {
      return { content: [{ type: "text", text: `OCR failed: ${e.message}` }] };
    }
  }
);

server.tool("clipboard_get", "Read the current clipboard text.", {}, async () => {
  if (!has("wl-paste")) return { content: [{ type: "text", text: "wl-paste not installed." }] };
  try {
    return { content: [{ type: "text", text: run("timeout", ["3", "wl-paste"], { timeout: 8000 }) }] };
  } catch {
    return { content: [{ type: "text", text: "(clipboard empty or non-text)" }] };
  }
});

server.tool(
  "clipboard_set",
  "Set the clipboard to the given text.",
  { text: z.string().describe("Text to put on the clipboard") },
  async ({ text }) => {
    if (!has("wl-copy")) return { content: [{ type: "text", text: "wl-copy not installed." }] };
    execFileSync("wl-copy", [], {
      input: text,
      stdio: ["pipe", "ignore", "ignore"],
      env: graphicalEnv,
    });
    return { content: [{ type: "text", text: "Clipboard set." }] };
  }
);

// ---------------------------------------------------------------- notify
server.tool(
  "notify",
  "Send a desktop notification (and optionally a phone push via ntfy if configured in ~/jarvis/.env).",
  {
    title: z.string().describe("Notification title"),
    message: z.string().describe("Notification body"),
    phone: z.boolean().describe("Also push to phone via ntfy. Default: false.").optional(),
  },
  async ({ title, message, phone = false }) => {
    const results = [];
    if (has("notify-send")) {
      try {
        run("notify-send", [title, message]);
        results.push("desktop: sent");
      } catch (e) {
        results.push(`desktop: failed (${e.stderr?.toString().trim() || e.message})`);
      }
    }
    if (phone) {
      const env = loadEnv();
      const topic = env.NTFY_TOPIC;
      if (!topic) {
        results.push("phone: skipped (NTFY_TOPIC not set in ~/jarvis/.env)");
      } else {
        try {
          execFileSync("curl", ["-sf", "-d", message, "-H", `Title: ${title}`, `https://ntfy.sh/${topic}`], { stdio: "ignore" });
          results.push("phone: sent via ntfy");
        } catch (e) {
          results.push(`phone: failed (${e.message})`);
        }
      }
    }
    return { content: [{ type: "text", text: results.join("; ") }] };
  }
);

// ---------------------------------------------------------------- voice
server.tool(
  "say",
  "Speak text aloud. Uses piper (neural TTS) by default; JARVIS_TTS=edge uses edge-tts; falls back to espeak-ng.",
  { text: z.string().describe("Text to speak") },
  async ({ text }) => {
    const env = loadEnv();
    const tts = env.JARVIS_TTS || "piper";
    if (tts === "edge") {
      if (!has("edge-tts")) return { content: [{ type: "text", text: "edge-tts not installed." }] };
      run("edge-tts", ["--voice", "en-US-ChristopherNeural", "--text", text, "--write-media", "/tmp/jarvis-tts.mp3"]);
      execFileSync("ffplay", ["-nodisp", "-autoexit", "/tmp/jarvis-tts.mp3"], { stdio: "ignore" });
      return { content: [{ type: "text", text: "Spoke (edge-tts)." }] };
    }
    const sayScript = join(JARVIS_DIR, "bin", "say.sh");
    try {
      execFileSync(sayScript, [text], { stdio: "ignore", timeout: 60000 });
      return { content: [{ type: "text", text: "Spoke (piper)." }] };
    } catch (e) {
      return { content: [{ type: "text", text: `TTS failed: ${e.message}` }] };
    }
  }
);

// ---------------------------------------------------------------- main
const transport = new StdioServerTransport();
await server.connect(transport);
