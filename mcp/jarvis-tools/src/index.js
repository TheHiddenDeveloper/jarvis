import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";

const HOME = homedir();
const JARVIS_DIR = join(HOME, "jarvis");
const MEMORY_DIR = join(JARVIS_DIR, "memory");
const SCREENSHOT_DIR = join(JARVIS_DIR, ".screenshots");
const STATE_DIR = join(JARVIS_DIR, "state");
const REMINDERS_FILE = join(STATE_DIR, "reminders.json");
const ENV_FILE = join(JARVIS_DIR, ".env");
const VAULT_DIR = join(HOME, "Ideaverse");
const VAULT_AGENTS = join(VAULT_DIR, ".agents", "agents");
const JARVIS_VAULT_DIR = join(JARVIS_DIR, "vault");
const LANDMARKS_FILE = join(JARVIS_VAULT_DIR, "Screen", "Landmarks.md");
const PROCEDURES_DIR = join(JARVIS_VAULT_DIR, "Procedures");
const PROCEDURES_INDEX = join(MEMORY_DIR, "procedures.md");

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
    execSync(`where.exe ${cmd}`, { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function readReminders() {
  if (!existsSync(REMINDERS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(REMINDERS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeReminders(list) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(REMINDERS_FILE, JSON.stringify(list, null, 2));
}

const graphicalEnv = {
  ...process.env,
};

function run(cmd, args = [], opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    timeout: 20000,
    env: graphicalEnv,
    windowsHide: true,
    ...opts,
  });
}

function captureScreenshot(region = false) {
  const file = join(SCREENSHOT_DIR, `shot-${Date.now()}.png`);
  try {
    // Use PowerShell to capture the full screen
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $screen = [System.Windows.Forms.Screen]::PrimaryScreen
      $bitmap = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($screen.Bounds.Location, [System.Drawing.Point]::Empty, $screen.Bounds.Size)
      $bitmap.Save('${file.replace(/\\/g, "\\\\")}')
      $graphics.Dispose()
      $bitmap.Dispose()
    `;
    execFileSync("powershell", ["-NoProfile", "-Command", psScript], {
      stdio: "ignore",
      timeout: 10000,
      windowsHide: true,
    });
    if (existsSync(file)) return file;
  } catch {}
  return null;
}

function pngDimensions(file) {
  const buf = readFileSync(file);
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

let _visionAI = null;
function getVisionAI() {
  if (_visionAI) return _visionAI;
  const key = loadEnv().GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set (add it to ~/jarvis/.env)");
  _visionAI = new GoogleGenAI({ apiKey: key });
  return _visionAI;
}

const VISION_MODEL = "gemini-3.1-flash-lite-preview";
const CLICK_MODEL = "gemini-2.5-flash";

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
    try {
      const out = run("findstr", ["/s", "/i", "/m", query, join(MEMORY_DIR, "*.md")]);
      return { content: [{ type: "text", text: out || "No matches." }] };
    } catch {
      return { content: [{ type: "text", text: "No matches." }] };
    }
  }
);

// ---------------------------------------------------------------- ideaverse (Obsidian vault)
// The Obsidian vault at ~/Ideaverse is the canonical long-term brain. The jarvis memory/
// files are the fast-access layer. These tools re-use the vault's own conventions and
// scripts (context-bridge, execution-logger, naming rules) rather than reinventing them.

function vaultResolve(notePath) {
  // Accept an absolute or vault-relative path. Reject traversal outside the vault.
  let p = resolve(VAULT_DIR, notePath);
  if (!p.startsWith(VAULT_DIR + "\\") && !p.startsWith(VAULT_DIR + "/") && p !== VAULT_DIR) {
    throw new Error(`Path escapes the vault: ${notePath}`);
  }
  return p;
}

function safeVaultName(name) {
  return name.replace(/[^a-z0-9-]/gi, "");
}

// ---------------------------------------------------------------- jarvis vault (screen learning)
// Jarvis's own vault at ~/jarvis/vault — separate from the human's Ideaverse. Holds
// screen landmarks (what is where) and procedures (how to do multi-step tasks).

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Record (or refresh) one landmark line in Screen/Landmarks.md, keyed by name.
function upsertLandmark({ name, app = "", x, y, screen = "", note = "" }) {
  mkdirSync(dirname(LANDMARKS_FILE), { recursive: true });
  const line = `- \`${name}\` | app: ${app || "—"} | pos: (${x}%, ${y}%)${screen ? ` | screen: ${screen}` : ""}${note ? ` | note: ${note}` : ""} | updated: ${today()}`;
  let text = "";
  if (existsSync(LANDMARKS_FILE)) text = readFileSync(LANDMARKS_FILE, "utf8");
  const re = new RegExp(`^- \`${name}\`.*$`, "m");
  if (re.test(text)) {
    text = text.replace(re, line);
  } else {
    text = `${text.trimEnd()}\n${line}\n`;
  }
  writeFileSync(LANDMARKS_FILE, text);
  return line;
}

// Build the strict procedure markdown from parts.
function buildProcedure({ title, trigger, preconditions, steps, failure, created }) {
  const date = today();
  const out = [];
  out.push("---");
  out.push(`title: "${title.trim()}"`);
  out.push("status: active");
  out.push(`created: ${created || date}`);
  out.push(`last_verified: ${date}`);
  out.push("tags: [engineering, procedures, jarvis, desktop]");
  out.push("---");
  out.push("");
  out.push(`# ${title.trim()}`);
  out.push("");
  out.push("## Trigger phrases");
  out.push(trigger.trim() || "-");
  out.push("");
  out.push("## Preconditions");
  out.push(preconditions.trim() || "-");
  out.push("");
  out.push("## Steps");
  steps.forEach((s, i) => {
    out.push(`${i + 1}. **Action:** ${String(s.action || "").trim()}`);
    out.push(`   **Expect:** ${String(s.expect || "").trim()}`);
  });
  out.push("");
  out.push("## Failure handling");
  out.push(failure.trim() || "-");
  out.push("");
  out.push(`## Last verified`);
  out.push(`- ${date}`);
  return out.join("\n");
}

// Upsert the fast index row in memory/procedures.md (title -> trigger phrase).
function upsertProcedureIndex(t, title, trigger) {
  mkdirSync(MEMORY_DIR, { recursive: true });
  const first = String(trigger || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
  const line = `- \`${t}\` | ${title.trim()} | triggers: "${first}" | last_verified: ${today()}`;
  let text = "";
  if (existsSync(PROCEDURES_INDEX)) text = readFileSync(PROCEDURES_INDEX, "utf8");
  const re = new RegExp(`^- \`${t}\`.*$`, "m");
  if (re.test(text)) {
    text = text.replace(re, line);
  } else {
    text = `${text.trimEnd()}\n${line}\n`;
  }
  writeFileSync(PROCEDURES_INDEX, text);
  return line;
}

function existingCreated(path) {
  if (!existsSync(path)) return null;
  const m = readFileSync(path, "utf8").match(/^created:\s*(\d{4}-\d{2}-\d{2})/m);
  return m ? m[1] : null;
}

server.tool(
  "vault_read",
  "Read a note from the Obsidian vault (~/Ideaverse). Path is relative to the vault root, e.g. 'Strategy/tech-wing-positioning' or 'DailyNotes/2026-08-01'. Optionally omit the .md extension. Accepts [[wikilink]] targets too.",
  { note: z.string().describe("Note path or [[wikilink]] target, relative to vault root") },
  async ({ note }) => {
    let p = note.replace(/^\[\[|\]\]$/g, "");
    if (!p.endsWith(".md")) p = `${p}.md`;
    const full = vaultResolve(p);
    if (!existsSync(full)) {
      // fall back to a vault-wide search for a note with that base name
      const base = safeVaultName(p.split("/").pop().replace(/\.md$/, ""));
      try {
        const found = run("findstr", ["/s", "/i", "/m", base, join(VAULT_DIR, "*.md")]).trim();
        if (!found) {
          return { content: [{ type: "text", text: `Note not found: ${p}` }] };
        }
        const hit = found.split("\n")[0];
        return { content: [{ type: "text", text: readFileSync(hit, "utf8") }] };
      } catch {
        return { content: [{ type: "text", text: `Note not found: ${p}` }] };
      }
    }
    return { content: [{ type: "text", text: readFileSync(full, "utf8") }] };
  }
);

server.tool(
  "vault_search",
  "Full-text search across the Obsidian vault (~/Ideaverse). Returns matching file paths (and line numbers). Excludes .obsidian and .git internals.",
  { query: z.string().describe("Search text or regex"), max: z.number().int().min(1).max(50).describe("Max results to return").optional() },
  async ({ query, max = 15 }) => {
    try {
      const out = run("findstr", ["/s", "/i", "/m", query, join(VAULT_DIR, "*.md")]);
      const lines = out.split("\n").filter(Boolean);
      const hits = lines.slice(0, max);
      const text = hits.length
        ? hits.map((h) => h.replace(VAULT_DIR + "\\", "").replace(VAULT_DIR + "/", "")).join("\n")
        : "No matches.";
      return { content: [{ type: "text", text: text }] };
    } catch {
      return { content: [{ type: "text", text: "No matches." }] };
    }
  }
);

server.tool(
  "vault_search_semantic",
  "Semantic (meaning-based) search across the Obsidian vault (~/Ideaverse) using local embeddings. Use when keyword search misses the intent. Returns ranked notes with snippets and similarity scores. First run builds the index (can take a minute).",
  {
    query: z.string().describe("Natural-language query, e.g. 'what pricing packages generate recurring revenue'"),
    k: z.number().int().min(1).max(10).describe("Max results to return").optional(),
    min_score: z.number().min(0).max(1).describe("Minimum similarity score (0-1). Lower = more results.").optional(),
  },
  async ({ query, k = 5, min_score = 0.2 }) => {
    const py = join(JARVIS_DIR, "venv", "Scripts", "python.exe");
    const script = join(JARVIS_DIR, "scripts", "vault-embed.py");
    if (!existsSync(py) || !existsSync(script)) {
      return { content: [{ type: "text", text: "Semantic search not set up (venv or vault-embed.py missing)." }] };
    }
    try {
      const out = run(py, [script, "search", query, "--k", String(k), "--min-score", String(min_score)], { timeout: 120000 });
      return { content: [{ type: "text", text: out || "No matches." }] };
    } catch (e) {
      const msg = e.stderr?.toString?.() || e.message || "";
      if (msg.includes("Index empty")) {
        // auto-build on first use
        try {
          const build = run(py, [script, "index"], { timeout: 300000 });
          const out = run(py, [script, "search", query, "--k", String(k), "--min-score", String(min_score)], { timeout: 60000 });
          return { content: [{ type: "text", text: `(index built first: ${build.trim().split("\n").pop()})\n\n${out || "No matches."}` }] };
        } catch (e2) {
          return { content: [{ type: "text", text: `Semantic search failed: ${e2.stderr?.toString?.() || e2.message}` }] };
        }
      }
      return { content: [{ type: "text", text: `Semantic search failed: ${msg}` }] };
    }
  }
);

server.tool(
  "vault_write",
  "Create or overwrite a note in the Obsidian vault (~/Ideaverse). Path relative to vault root (e.g. 'Strategy/my-note'). Follows vault naming: PascalCase dirs, kebab-case notes, no spaces. A dated entry is appended if the note exists.",
  {
    note: z.string().describe("Note path relative to vault root, e.g. 'Strategy/tech-wing-positioning'"),
    content: z.string().describe("Full markdown body (omit YAML frontmatter unless desired)"),
  },
  async ({ note, content }) => {
    const p = note.endsWith(".md") ? note : `${note}.md`;
    const full = vaultResolve(p);
    mkdirSync(dirname(full), { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    if (existsSync(full)) {
      appendFileSync(full, `\n### ${date}\n${content.trim()}\n`);
      return { content: [{ type: "text", text: `Appended dated section to ${p}` }] };
    }
    writeFileSync(full, `# ${note.split("/").pop()}\n\n${content.trim()}\n`);
    return { content: [{ type: "text", text: `Created note ${p}` }] };
  }
);

server.tool(
  "vault_context",
  "Print a snapshot of the vault state (tasks, daily note, reports) using the vault's own context-bridge. Run at session start before working in the vault.",
  {},
  async () => {
    // On Windows, read vault state directly instead of calling bash scripts
    const lines = [];
    const today = new Date().toISOString().slice(0, 10);
    const dailyNote = join(VAULT_DIR, "DailyNotes", `${today}.md`);
    if (existsSync(dailyNote)) {
      lines.push("## Today's Daily Note");
      lines.push(readFileSync(dailyNote, "utf8").slice(0, 2000));
    }
    // Check for task files
    const inboxDir = join(VAULT_DIR, "Inbox");
    if (existsSync(inboxDir)) {
      const tasks = readdirSync(inboxDir).filter(f => f.endsWith(".md")).slice(0, 10);
      if (tasks.length) {
        lines.push("\n## Inbox");
        lines.push(tasks.join("\n"));
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") || "Vault context loaded (no daily note found)." }] };
  }
);

server.tool(
  "vault_log",
  "Log a Post-Flight Protocol entry (the vault's execution-logger): appends an [Execution Log] to today's daily note and creates a report in .agents/reports/. Run after completing work in the vault.",
  {
    title: z.string().describe("Short title of the task, e.g. 'Built X integration'"),
    desc: z.string().describe("What was done"),
    mutations: z.string().describe("Files created/modified (comma-separated)").optional(),
    knowledge: z.string().describe("Anything learned or any errors overcome").optional(),
  },
  async ({ title, desc, mutations = "None", knowledge = "None" }) => {
    // On Windows, log execution directly instead of calling bash scripts
    const today = new Date().toISOString().slice(0, 10);
    const dailyDir = join(VAULT_DIR, "DailyNotes");
    mkdirSync(dailyDir, { recursive: true });
    const dailyNote = join(dailyDir, `${today}.md`);
    const entry = `\n### ${new Date().toLocaleTimeString()} - ${title}\n${desc}\nFiles: ${mutations}\nLearned: ${knowledge}\n`;
    if (existsSync(dailyNote)) {
      appendFileSync(dailyNote, entry);
    } else {
      writeFileSync(dailyNote, `# ${today}\n${entry}`);
    }
    return { content: [{ type: "text", text: `Logged "${title}" to ${today}.md` }] };
  }
);

// ---------------------------------------------------------------- system
server.tool(
  "system_info",
  "Report OS, session type, and availability of automation tools.",
  {},
  async () => {
    const checks = ["tesseract", "ffmpeg", "ffplay", "curl", "where", "powershell"];
    const info = checks.map((c) => `${c}=${has(c) ? "yes" : "no"}`).join("\n");
    const os = run("powershell", ["-NoProfile", "-Command", "[System.Environment]::OSVersion.VersionString"], { stdio: "pipe" }).trim();
    return { content: [{ type: "text", text: `OS: ${os}\nPlatform: Windows\nTools:\n${info}` }] };
  }
);

server.tool(
  "open_app",
  "Launch an application by name (uses kde-open / gtk-launch / flatpak).",
  { app: z.string().describe("Application name, e.g. 'brave', 'obsidian', 'kate'") },
  async ({ app }) => {
    try {
      // On Windows, try Start-Process or shell:appsfolder
      execSync(`powershell -NoProfile -Command "Start-Process '${app.replace(/'/g, "''")}'"`, {
        stdio: "ignore",
        timeout: 10000,
        windowsHide: true,
      });
      return { content: [{ type: "text", text: `Launched ${app}.` }] };
    } catch {
      return { content: [{ type: "text", text: `Could not launch "${app}".` }] };
    }
  }
);

// ---------------------------------------------------------------- desktop
server.tool(
  "type_text",
  "Type text into the focused window (Wayland: wtype).",
  { text: z.string().describe("Text to type") },
  async ({ text }) => {
    try {
      // Use PowerShell SendKeys for typing on Windows
      const psScript = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${text.replace(/"/g, '\\"').replace(/'/g, "''")}")`;
      execSync(`powershell -NoProfile -Command "${psScript}"`, { stdio: "ignore", timeout: 5000, windowsHide: true });
      return { content: [{ type: "text", text: `Typed ${text.length} chars.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Type failed: ${e.message}` }] };
    }
  }
);

server.tool(
  "press_key",
  "Send a keyboard shortcut to the focused window, e.g. 'ctrl+c', 'Return', 'alt+Tab'.",
  { key: z.string().describe("Key combination, e.g. 'ctrl+c' or 'Return'") },
  async ({ key }) => {
    try {
      // Map common key names to Windows SendKeys format
      const keyMap = {
        "Return": "{ENTER}", "enter": "{ENTER}",
        "BackSpace": "{BACKSPACE}", "backspace": "{BACKSPACE}",
        "Tab": "{TAB}", "tab": "{TAB}",
        "Escape": "{ESC}", "escape": "{ESC}", "esc": "{ESC}",
        "Delete": "{DELETE}", "delete": "{DELETE}",
        "Up": "{UP}", "up": "{UP}",
        "Down": "{DOWN}", "down": "{DOWN}",
        "Left": "{LEFT}", "left": "{LEFT}",
        "Right": "{RIGHT}", "right": "{RIGHT}",
        "Home": "{HOME}", "home": "{HOME}",
        "End": "{END}", "end": "{END}",
        "Page_Up": "{PGUP}", "PageUp": "{PGUP}",
        "Page_Down": "{PGDN}", "PageDown": "{PGDN}",
        "F1": "{F1}", "F2": "{F2}", "F3": "{F3}", "F4": "{F4}",
        "F5": "{F5}", "F6": "{F6}", "F7": "{F7}", "F8": "{F8}",
        "F9": "{F9}", "F10": "{F10}", "F11": "{F11}", "F12": "{F12}",
        "ctrl+c": "^c", "ctrl+v": "^v", "ctrl+x": "^x", "ctrl+z": "^z",
        "ctrl+a": "^a", "ctrl+s": "^s", "ctrl+f": "^f",
        "alt+Tab": "%{TAB}", "alt+tab": "%{TAB}",
      };
      const mapped = keyMap[key] || `{${key}}`;
      const psScript = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${mapped}")`;
      execSync(`powershell -NoProfile -Command "${psScript}"`, { stdio: "ignore", timeout: 5000, windowsHide: true });
      return { content: [{ type: "text", text: `Pressed ${key}.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Key press failed: ${e.message}` }] };
    }
  }
);

server.tool(
  "mouse_move",
  "Move the mouse pointer to absolute screen coordinates (ydotool). Needs the ydotool daemon running.",
  { x: z.number().describe("X coordinate"), y: z.number().describe("Y coordinate") },
  async ({ x, y }) => {
    try {
      // Use PowerShell with System.Windows.Forms for mouse movement
      const psScript = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})`;
      execSync(`powershell -NoProfile -Command "${psScript}"`, { stdio: "ignore", timeout: 5000, windowsHide: true });
      return { content: [{ type: "text", text: `Moved pointer to (${x}, ${y}).` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Mouse move failed: ${e.message}` }] };
    }
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
    try {
      const downMap = { left: "0x02", right: "0x08", middle: "0x20" };
      const upMap = { left: "0x04", right: "0x10", middle: "0x40" };
      const down = downMap[button];
      const up = upMap[button];
      const psScript = "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class MouseOps { [DllImport(\"user32.dll\")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo); }'; " +
        "$d = " + down + "; $u = " + up + "; " +
        "for ($i = 0; $i -lt " + count + "; $i++) { " +
        "[MouseOps]::mouse_event($d, 0, 0, 0, 0); " +
        "[MouseOps]::mouse_event($u, 0, 0, 0, 0); " +
        "Start-Sleep -Milliseconds 50 }";
      execSync('powershell -NoProfile -Command "' + psScript.replace(/"/g, '\\"') + '"', {
        stdio: "ignore", timeout: 5000, windowsHide: true,
      });
      return { content: [{ type: "text", text: "Clicked " + button + " x" + count + "." }] };
    } catch (e) {
      return { content: [{ type: "text", text: "Click failed: " + e.message }] };
    }
  }
);

server.tool(
  "screenshot",
  "Capture the screen (full). On Windows uses PowerShell with System.Drawing. Optionally run OCR on it with tesseract. Returns the saved image path and any OCR text.",
  {
    region: z.boolean().describe("If true, capture a rectangular region (interactive selection on KDE; slurp on other compositors). Default: full screen.").optional(),
    ocr: z.boolean().describe("Run OCR on the capture. Default: false.").optional(),
  },
  async ({ region = false, ocr = false }) => {
    const file = captureScreenshot(region);
    if (!file) return { content: [{ type: "text", text: "Screenshot failed: neither Spectacle nor grim could capture (compositor may not support screen capture protocol)." }] };
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

// ---------------------------------------------------------------- vision (Gemini)
server.tool(
  "see_screen",
  "Capture the screen (or a region) and analyze it with Gemini vision. Understands layout, UI state, images, and content — not just text like OCR. Use this when you need to know what is actually on the screen (e.g. 'what's on my screen?', 'is there an error dialog?', 'what app is focused?').",
  {
    prompt: z.string().describe("What to look for or ask about the screen").default("Describe what is on the screen in detail."),
    region: z.boolean().describe("If true, capture a rectangular region (interactive selection). Default: full screen.").optional(),
  },
  async ({ prompt = "Describe what is on the screen in detail.", region = false }) => {
    const file = captureScreenshot(region);
    if (!file) return { content: [{ type: "text", text: "Screenshot failed." }] };
    try {
      const data = readFileSync(file).toString("base64");
      const ai = getVisionAI();
      const resp = await ai.models.generateContent({
        model: loadEnv().SEE_SCREEN_MODEL || VISION_MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: "image/png", data } }] }],
      });
      return { content: [{ type: "text", text: `Analyzed ${file}\n${resp.text || "(no response)"}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Vision analysis failed: ${e.message}` }] };
    }
  }
);

server.tool(
  "click_on",
  "Look at the screen with Gemini vision, locate the element matching your description, move the mouse to its center and click it. Use for UI automation (e.g. 'click the submit button', 'click the settings gear'). Returns the pixel coordinate clicked. Requires the ydotool daemon.",
  {
    prompt: z.string().describe("Describe the element to click, e.g. 'the green submit button' or 'the settings gear icon'"),
    button: z.enum(["left", "right", "middle"]).describe("Which button").default("left"),
    count: z.number().int().describe("Number of clicks").default(1),
    name: z.string().describe("Optional kebab-case name to remember this element's location as a landmark for future reuse, e.g. 'wifi-icon'").optional(),
  },
  async ({ prompt, button = "left", count = 1, name }) => {
    if (!has("ydotool")) return { content: [{ type: "text", text: "ydotool not installed." }] };
    const file = captureScreenshot(false);
    if (!file) return { content: [{ type: "text", text: "Screenshot failed." }] };
    const dims = pngDimensions(file);
    if (!dims) return { content: [{ type: "text", text: "Could not read screenshot dimensions." }] };
    try {
      const data = readFileSync(file).toString("base64");
      const ai = getVisionAI();
      const resp = await ai.models.generateContent({
        model: loadEnv().CLICK_ON_MODEL || CLICK_MODEL,
        contents: [{ role: "user", parts: [{ text: `Screen dimensions: ${dims.width}x${dims.height}px. Find the element: "${prompt}". Respond with ONLY a JSON object: {"x_percent": <0-100 center x>, "y_percent": <0-100 center y>}. If the element is not visible, respond {"error": "not found"}.` }, { inlineData: { mimeType: "image/png", data } }] }],
      });
      const raw = (resp.text || "").trim();
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return { content: [{ type: "text", text: `No coordinates returned: ${raw.slice(0, 300)}` }] };
      const parsed = JSON.parse(m[0]);
      if (parsed.error) return { content: [{ type: "text", text: `Element not found: ${parsed.error}` }] };
      const x = Math.round((Number(parsed.x_percent) / 100) * dims.width);
      const y = Math.round((Number(parsed.y_percent) / 100) * dims.height);
      const codes = { left: "0xC0", right: "0xC1", middle: "0xC2" };
      try {
        run("ydotool", ["mousemove", "--absolute", "--x", String(x), "--y", String(y)]);
        run("ydotool", ["click", codes[button], String(count)]);
      } catch (e) {
        return { content: [{ type: "text", text: `Located "${prompt}" at (${x}, ${y}) but could not move/click (is the ydotool daemon running?): ${e.message}` }] };
      }
      let extra = "";
      if (name) {
        const slug = slugify(name);
        if (slug) {
          try {
            upsertLandmark({ name: slug, x: Number(parsed.x_percent), y: Number(parsed.y_percent), screen: `${dims.width}x${dims.height}`, note: prompt });
            extra = ` Recorded landmark \`${slug}\`.`;
          } catch (e) {
            extra = ` (could not record landmark: ${e.message})`;
          }
        }
      }
      return { content: [{ type: "text", text: `Clicked "${prompt}" at (${x}, ${y}) px (${parsed.x_percent}%, ${parsed.y_percent}%).${extra}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `click_on failed: ${e.message}` }] };
    }
  }
);

server.tool(
  "record_landmark",
  "Remember a stable UI element's position on screen so future operations can reuse it instead of re-searching. Stores to the Jarvis vault (Screen/Landmarks.md) keyed by name; re-recording the same name refreshes it. Coordinates are percentages of the full screen (0-100).",
  {
    name: z.string().describe("Short kebab-case name for the element, e.g. 'wifi-icon' or 'submit-button'"),
    x_percent: z.number().describe("Center X as percentage of screen width (0-100)"),
    y_percent: z.number().describe("Center Y as percentage of screen height (0-100)"),
    app: z.string().describe("App/window context where the element lives, e.g. 'system-tray'").optional(),
    screen: z.string().describe("Screen resolution at recording time, e.g. '6072x2000'").optional(),
    note: z.string().describe("Any useful note (what it does, how it looks)").optional(),
  },
  async ({ name, x_percent, y_percent, app, screen, note }) => {
    const slug = slugify(name);
    if (!slug) return { content: [{ type: "text", text: "name must be non-empty text." }] };
    if (
      typeof x_percent !== "number" || typeof y_percent !== "number" ||
      x_percent < 0 || x_percent > 100 || y_percent < 0 || y_percent > 100
    ) {
      return { content: [{ type: "text", text: `Coordinates must be numbers in 0-100, got (${x_percent}, ${y_percent}).` }] };
    }
    try {
      const line = upsertLandmark({ name: slug, app, x: x_percent, y: y_percent, screen, note });
      return { content: [{ type: "text", text: `Recorded landmark \`${slug}\` → ${LANDMARKS_FILE}\n${line}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `record_landmark failed: ${e.message}` }] };
    }
  }
);

server.tool(
  "save_procedure",
  "Save or update a multi-step desktop procedure so Jarvis can replay it later. Writes a templated note to the Jarvis vault (Procedures/<title>.md) and refreshes the fast index in ~/jarvis/memory/procedures.md. Re-saving the same title updates it in place.",
  {
    title: z.string().describe("Short kebab-case title, e.g. 'check-wifi-status'"),
    trigger: z.string().describe("Trigger phrases, one per line, e.g. 'check the wifi status'").optional().default("-"),
    preconditions: z.string().describe("Required starting state").optional().default("-"),
    steps: z.array(
      z.object({
        action: z.string().describe("The tool call + args to perform"),
        expect: z.string().describe("The on-screen state to verify after this step"),
      })
    ).describe("Ordered steps: each has an action and the expected on-screen state to verify"),
    failure: z.string().describe("What to do if a step's expected state isn't met").optional().default("-"),
  },
  async ({ title, trigger = "-", preconditions = "-", steps, failure = "-" }) => {
    if (!Array.isArray(steps) || steps.length === 0) {
      return { content: [{ type: "text", text: "steps must be a non-empty array of {action, expect}." }] };
    }
    try {
      const t = slugify(title);
      if (!t) return { content: [{ type: "text", text: "title must be non-empty text." }] };
      mkdirSync(PROCEDURES_DIR, { recursive: true });
      const path = join(PROCEDURES_DIR, `${t}.md`);
      const existed = existsSync(path);
      const md = buildProcedure({ title, trigger, preconditions, steps, failure, created: existingCreated(path) });
      writeFileSync(path, md);
      const index = upsertProcedureIndex(t, title, trigger);
      return { content: [{ type: "text", text: `${existed ? "Updated" : "Saved"} procedure \`${t}\` → ${path}\nIndex: ${index}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `save_procedure failed: ${e.message}` }] };
    }
  }
);

server.tool(
  "graph_recall",
  "Graph-aware recall over the Jarvis vault: embeds your query, finds seed notes, then spreads activation across the knowledge graph (Personalized PageRank / random walk with restart) to return the most relevant context — procedures, landmarks, memory topics — each with a traversal path. The fastest way to recall what Jarvis already knows. First run builds the index (~1 min); later runs are incremental.",
  {
    query: z.string().describe("Natural-language request or task"),
    k: z.number().int().min(1).max(10).describe("Max results to return").optional(),
  },
  async ({ query, k = 5 }) => {
    const py = join(JARVIS_DIR, "venv", "Scripts", "python.exe");
    const script = join(JARVIS_DIR, "scripts", "jarvis-kg.py");
    if (!existsSync(py) || !existsSync(script)) {
      return { content: [{ type: "text", text: "Knowledge graph not set up (venv or jarvis-kg.py missing)." }] };
    }
    try {
      const out = run(py, [script, "search", query, "--k", String(k)], { timeout: 120000 });
      return { content: [{ type: "text", text: out || "No matches." }] };
    } catch (e) {
      const msg = e.stderr?.toString?.() || e.message || "";
      if (msg.includes("KG empty")) {
        try {
          const build = run(py, [script, "index"], { timeout: 300000 });
          const out = run(py, [script, "search", query, "--k", String(k)], { timeout: 60000 });
          return { content: [{ type: "text", text: `(index built first: ${build.trim().split("\n").pop()})\n\n${out || "No matches."}` }] };
        } catch (e2) {
          return { content: [{ type: "text", text: `graph_recall failed: ${e2.stderr?.toString?.() || e2.message}` }] };
        }
      }
      return { content: [{ type: "text", text: `graph_recall failed: ${msg}` }] };
    }
  }
);

server.tool(
  "graph_reindex",
  "Rebuild/refresh the Jarvis knowledge graph index (picks up new/edited procedures, landmarks, and memory notes incrementally by mtime). Run this after saving new knowledge so graph_recall sees it. Use force to rebuild everything from scratch.",
  { force: z.boolean().describe("Rebuild all embeddings from scratch (slower). Default: incremental.").optional() },
  async ({ force = false }) => {
    const py = join(JARVIS_DIR, "venv", "Scripts", "python.exe");
    const script = join(JARVIS_DIR, "scripts", "jarvis-kg.py");
    if (!existsSync(py) || !existsSync(script)) {
      return { content: [{ type: "text", text: "Knowledge graph not set up (venv or jarvis-kg.py missing)." }] };
    }
    try {
      const args = [script, "index"];
      if (force) args.push("--force");
      const out = run(py, args, { timeout: 300000 });
      return { content: [{ type: "text", text: out.trim() || "Reindexed." }] };
    } catch (e) {
      return { content: [{ type: "text", text: `graph_reindex failed: ${e.stderr?.toString?.() || e.message}` }] };
    }
  }
);

server.tool("clipboard_get", "Read the current clipboard text.", {}, async () => {
  try {
    const text = run("powershell", ["-NoProfile", "-Command", "Get-Clipboard"], { stdio: "pipe" });
    return { content: [{ type: "text", text: text || "(clipboard empty)" }] };
  } catch {
    return { content: [{ type: "text", text: "(clipboard empty or non-text)" }] };
  }
});

server.tool(
  "clipboard_set",
  "Set the clipboard to the given text.",
  { text: z.string().describe("Text to put on the clipboard") },
  async ({ text }) => {
    try {
      // Use clip.exe for setting clipboard on Windows
      const proc = execSync(`clip.exe`, {
        input: text,
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 5000,
        windowsHide: true,
      });
      return { content: [{ type: "text", text: "Clipboard set." }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Clipboard set failed: ${e.message}` }] };
    }
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
    // Windows toast notification
    try {
      const psScript = `
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
        $template = @"
        <toast>
          <visual>
            <binding template="ToastGeneric">
              <text>${title.replace(/"/g, '\\"')}</text>
              <text>${message.replace(/"/g, '\\"')}</text>
            </binding>
          </visual>
        </toast>
"@
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml($template)
        $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Jarvis").Show($toast)
      `;
      execSync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, {
        stdio: "ignore", timeout: 5000, windowsHide: true,
      });
      results.push("desktop: sent");
    } catch (e) {
      results.push(`desktop: failed (${e.message})`);
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

// ---------------------------------------------------------------- system admin (read-only)
server.tool(
  "system_status",
  "Report machine health: disk, memory, uptime, load, failed systemd units, pending pacman updates. Read-only.",
  {},
  async () => {
    const out = [];
    try {
      const disk = run("powershell", ["-NoProfile", "-Command", "Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{N='Used(GB)';E={[math]::Round($_.Used/1GB,1)}},@{N='Free(GB)';E={[math]::Round($_.Free/1GB,1)}} | Format-Table -AutoSize"], { stdio: "pipe" }).trim();
      out.push("### Disk\n" + disk);
    } catch (e) { out.push(`disk: ${e.message}`); }
    try {
      const mem = run("powershell", ["-NoProfile", "-Command", "$os = Get-CimInstance Win32_OperatingSystem; Write-Host ('Total: {0:N1} GB' -f ($os.TotalVisibleMemorySize/1MB)); Write-Host ('Free: {0:N1} GB' -f ($os.FreePhysicalMemory/1MB)); Write-Host ('Used: {0:N1} GB' -f (($os.TotalVisibleMemorySize - $os.FreePhysicalMemory)/1MB))"], { stdio: "pipe" }).trim();
      out.push("### Memory\n" + mem);
    } catch (e) { out.push(`memory: ${e.message}`); }
    try {
      const boot = run("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime"], { stdio: "pipe" }).trim();
      out.push("### Uptime\nLast boot: " + boot);
    } catch (e) { out.push(`uptime: ${e.message}`); }
    try {
      const failed = run("powershell", ["-NoProfile", "-Command", "Get-Service | Where-Object {$_.Status -ne 'Running' -and $_.StartType -eq 'Automatic'} | Select-Object Name,Status | Format-Table -AutoSize"], { stdio: "pipe" }).trim();
      out.push("### Failed services\n" + (failed ? failed : "none"));
    } catch (e) { out.push(`services: ${e.message}`); }
    try {
      const upd = run("winget", ["list", "--upgradable"], { timeout: 60000 });
      const lines = upd.split("\n").filter(l => l.trim() && !l.startsWith("Name") && !l.startsWith("---"));
      out.push(`### Updates\n${lines.length ? lines.length + " available" : "up to date"}`);
    } catch (e) { out.push(`updates: ${e.message}`); }
    return { content: [{ type: "text", text: out.join("\n\n") }] };
  }
);

server.tool(
  "pkg_updates",
  "List available system package updates (pacman -Qu). Read-only; only query, never applies.",
  { limit: z.number().int().min(1).max(100).describe("Max packages to list").optional() },
  async ({ limit = 20 }) => {
    try {
      const out = run("winget", ["list", "--upgradable"], { timeout: 60000 });
      const lines = out.split("\n").filter(l => l.trim() && !l.startsWith("Name") && !l.startsWith("---") && !l.startsWith("Upgrade"));
      const shown = lines.slice(0, limit);
      return { content: [{ type: "text", text: shown.join("\n") || "No updates available." }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Could not check updates: ${e.message}` }] };
    }
  }
);

// ---------------------------------------------------------------- reminders
server.tool(
  "remind_add",
  "Add a dated reminder. Fires a desktop notification once its time (epoch ms) has passed. Times are absolute; use minutes/seconds helper outside.",
  {
    text: z.string().describe("What to be reminded of"),
    at: z.number().describe("Unix epoch (milliseconds) when it should fire"),
  },
  async ({ text, at }) => {
    const list = readReminders();
    const r = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, at, done: false };
    list.push(r);
    writeReminders(list);
    return { content: [{ type: "text", text: `Reminder set: "${text}" at ${new Date(at).toISOString()}` }] };
  }
);

server.tool(
  "remind_list",
  "List all reminders: due now, still pending (future), and already fired (done).",
  {},
  async () => {
    const now = Date.now();
    const list = readReminders();
    const fmt = (r) => `${r.id}  ${new Date(r.at).toISOString()}  ${r.text}`;
    const due = list.filter((r) => r.at <= now && !r.done).map(fmt);
    const pending = list.filter((r) => r.at > now && !r.done).map(fmt);
    const done = list.filter((r) => r.done).map(fmt);
    const sections = [
      due.length ? `DUE / fired-on-next-\`remind_fire\`:\n${due.join("\n")}` : "",
      pending.length ? `PENDING:\n${pending.join("\n")}` : "",
      done.length ? `DONE:\n${done.join("\n")}` : "",
    ].filter(Boolean).join("\n\n") || "No reminders.";
    return { content: [{ type: "text", text: sections }] };
  }
);

server.tool(
  "remind_clear",
  "Remove all reminders matching the given text, or a specific id.",
  {
    id: z.string().describe("Specific reminder id to clear").optional(),
    text: z.string().describe("Text substring to match and clear").optional(),
  },
  async ({ id, text }) => {
    const list = readReminders();
    const keep = list.filter((r) => !( (id && r.id === id) || (text && r.text.includes(text)) ));
    const removed = list.length - keep.length;
    writeReminders(keep);
    return { content: [{ type: "text", text: removed ? `Removed ${removed} reminder(s).` : "Nothing to remove." }] };
  }
);

server.tool(
  "remind_fire",
  "Check for due reminders whose time has passed. Sends a desktop notification (and phone push if requested) for each and marks them done. Call this from a cron/timer.",
  { phone: z.boolean().describe("Also push to phone via ntfy").optional(false) },
  async ({ phone = false }) => {
    const now = Date.now();
    const list = readReminders();
    const fired = [];
    for (const r of list) {
      if (r.at && r.at <= now && !r.done) {
        try {
          const results = [];
          if (has("notify-send")) {
            run("notify-send", ["⏰ Reminder", r.text]);
            results.push("desktop");
          }
          if (phone) {
            const env = loadEnv();
            const topic = env.NTFY_TOPIC;
            if (topic) {
              execFileSync("curl", ["-sf", "-d", r.text, "-H", "Title: ⏰ Reminder", `https://ntfy.sh/${topic}`], { stdio: "ignore" });
              results.push("phone");
            }
          }
          r.done = true;
          fired.push(`${r.text} (${results.join(", ") || "no notifier"})`);
        } catch (e) {
          fired.push(`${r.text} (failed: ${e.message})`);
        }
      }
    }
    if (list.some((r) => r.done)) writeReminders(list);
    return { content: [{ type: "text", text: fired.length ? `Fired:\n${fired.join("\n")}` : "No reminders due." }] };
  }
);

// ---------------------------------------------------------------- email (msmtp)
function msmtpAccount() {
  const env = loadEnv();
  return env.MSMTP_ACCOUNT || "default";
}

server.tool(
  "email_send",
  "Send an email via msmtp. Needs ~/.config/msmtp/config (account 'default' unless MSMTP_ACCOUNT in ~/jarvis/.env). Plain text by default; html if you pass content-type.",
  {
    to: z.string().describe("Recipient address(es), comma-separated"),
    subject: z.string().describe("Subject line"),
    body: z.string().describe("Message body (plain text)"),
    cc: z.string().describe("CC address(es)").optional(),
    bcc: z.string().describe("BCC address(es)").optional(),
    html: z.boolean().describe("Send body as text/html. Default false.").optional(),
    attach: z.string().describe("Absolute path to a file to attach").optional(),
  },
  async ({ to, subject, body, cc, bcc, html = false, attach }) => {
    const env = loadEnv();
    const from = env.MSMTP_FROM || env.SMTP_FROM || "";
    try {
      // Use PowerShell Send-MailMessage on Windows
      const params = ["-NoProfile", "-Command", `Send-MailMessage -To '${to}' -Subject '${subject.replace(/'/g, "''")}' -Body '${body.replace(/'/g, "''")}' -SmtpServer '${env.SMTP_SERVER || "smtp.gmail.com"}' -Port ${env.SMTP_PORT || 587} -UseSsl`];
      if (from) params[2] += ` -From '${from}'`;
      if (cc) params[2] += ` -Cc '${cc}'`;
      if (bcc) params[2] += ` -Bcc '${bcc}'`;
      if (attach) params[2] += ` -Attachments '${attach}'`;
      execSync(`powershell ${params.map(p => `"${p}"`).join(" ")}`, { stdio: "ignore", timeout: 30000, windowsHide: true });
      return { content: [{ type: "text", text: `Email sent to ${to}.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Email failed: ${e.message}` }] };
    }
  }
);

server.tool(
  "email_config_status",
  "Check whether msmtp is configured (~/.config/msmtp/config + account) and report sendable status.",
  {},
  async () => {
    const env = loadEnv();
    const lines = [];
    lines.push(`SMTP server: ${env.SMTP_SERVER || "not set (set SMTP_SERVER in ~/jarvis/.env)"}`);
    lines.push(`SMTP port: ${env.SMTP_PORT || "not set (set SMTP_PORT in ~/jarvis/.env)"}`);
    lines.push(`From: ${env.MSMTP_FROM || env.SMTP_FROM || "not set (set SMTP_FROM in ~/jarvis/.env)"}`);
    const ready = env.SMTP_SERVER && (env.MSMTP_FROM || env.SMTP_FROM);
    lines.push(`status: ${ready ? "READY" : "need config (set SMTP_SERVER, SMTP_FROM, SMTP_PORT in ~/jarvis/.env)"}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ---------------------------------------------------------------- calendar (khal + vdirsyncer)
server.tool(
  "calendar_next",
  "Show upcoming calendar events (khal). Uses the configured khal calendar.",
  {
    days: z.number().int().min(1).max(60).describe("How many days ahead. Default 7.").optional(),
    calendar: z.string().describe("Restrict to one calendar name").optional(),
  },
  async ({ days = 7, calendar }) => {
    try {
      // Use Outlook COM on Windows
      const psScript = `
        $outlook = New-Object -ComObject Outlook.Application
        $ns = $outlook.GetNamespace("MAPI")
        $folder = $ns.GetDefaultFolder(6) # olFolderCalendar
        $items = $folder.Items
        $items.Sort("[Start]")
        $items.IncludeRecurrences = $true
        $start = Get-Date
        $end = $start.AddDays(${days})
        $filter = "[Start] >= '{0}' AND [Start] <= '{1}'" -f $start.ToString("g"), $end.ToString("g")
        $restricted = $items.Restrict($filter)
        foreach ($item in $restricted) {
          Write-Host ("{0} - {1}: {2}" -f $item.Start.ToString("g"), $item.Duration.ToString(), $item.Subject)
        }
      `;
      const out = run("powershell", ["-NoProfile", "-Command", psScript], { stdio: "pipe", timeout: 30000 });
      return { content: [{ type: "text", text: out.trim() || "(no events)" }] };
    } catch (e) {
      return { content: [{ type: "text", text: `calendar failed: ${e.message}` }] };
    }
  }
);

server.tool(
  "calendar_add",
  "Add an event to a khal calendar (writes a local .ics). Run calendar_sync afterwards to upload it to the Google calendar.",
  {
    date: z.string().describe("Start date/time, e.g. '2026-08-10 14:00' or '2026-08-10'"),
    summary: z.string().describe("Event title"),
    end: z.string().describe("End date/time, e.g. '2026-08-10 15:00'").optional(),
    location: z.string().describe("Event location").optional(),
    description: z.string().describe("Event description (placed after '::' in the summary arg)").optional(),
    calendar: z.string().describe("Calendar to use (default: first configured)").optional(),
  },
  async ({ date, summary, end, location, description, calendar }) => {
    try {
      // Use Outlook COM on Windows
      const endDate = end || date;
      const psScript = `
        $outlook = New-Object -ComObject Outlook.Application
        $appt = $outlook.CreateItem(1) # olAppointmentItem
        $appt.Subject = '${summary.replace(/'/g, "''")}'
        $appt.Start = '${date}'
        $appt.End = '${endDate}'
        ${location ? `$appt.Location = '${location.replace(/'/g, "''")}'` : ""}
        ${description ? `$appt.Body = '${description.replace(/'/g, "''")}'` : ""}
        $appt.Save()
        Write-Host "Event created: $summary"
      `;
      const out = run("powershell", ["-NoProfile", "-Command", psScript], { stdio: "pipe", timeout: 30000 });
      return { content: [{ type: "text", text: out.trim() || "Event added via Outlook." }] };
    } catch (e) {
      return { content: [{ type: "text", text: `calendar_add failed: ${e.message}` }] };
    }
  }
);

server.tool(
  "calendar_sync",
  "Synchronize calendars via vdirsyncer (CalDAV). Run after adding events on another device, or before calendar_next.",
  {},
  async () => {
    // On Windows, Outlook handles sync automatically via Exchange/ActiveSync
    return { content: [{ type: "text", text: "Outlook on Windows syncs automatically via Exchange/ActiveSync. No manual sync needed." }] };
  }
);

server.tool(
  "calendar_config_status",
  "Check whether khal/vdirsyncer are configured (config files + storage).",
  {},
  async () => {
    const lines = [];
    try {
      // Check if Outlook is installed
      const psScript = `if (Test-Path "HKLM:\\SOFTWARE\\Microsoft\\Office\\*\\Outlook") { Write-Host "installed" } else { Write-Host "not found" }`;
      const result = run("powershell", ["-NoProfile", "-Command", psScript], { stdio: "pipe" }).trim();
      lines.push(`Outlook: ${result === "installed" ? "installed" : "not found"}`);
      lines.push(`status: ${result === "installed" ? "READY (uses Outlook COM)" : "Outlook not detected"}`);
    } catch (e) {
      lines.push(`Outlook check failed: ${e.message}`);
      lines.push("status: unknown");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ---------------------------------------------------------------- web
server.tool(
  "web_fetch",
  "Fetch a URL and return its text content. Lightweight; prefers no browser. Use for reading pages/APIs. Returns raw text or selected part.",
  { url: z.string().describe("Full URL to fetch") , max_chars: z.number().int().min(100).max(50000).describe("Max chars to return").optional(8000) },
  async ({ url, max_chars = 8000 }) => {
    try {
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Jarvis)" } });
      const text = await res.text();
      return { content: [{ type: "text", text: `HTTP ${res.status}\n\n${text.slice(0, max_chars)}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `web_fetch failed: ${e.message}` }] };
    }
  }
);

server.tool(
  "web_search",
  "Search the web via DuckDuckGo lite (no browser). Returns a numbered list of title / snippet / URL.",
  { query: z.string().describe("Search query"), count: z.number().int().min(1).max(10).describe("How many results").optional(5) },
  async ({ query, count = 5 }) => {
    try {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { "user-agent": "Mozilla/5.0 (Jarvis)" },
      });
      const html = await res.text();
      const results = [];
      const blockRe = /<a[^>]*class="result__a"[^>]*>(.*?)<\/a>/gi;
      let m;
      while ((m = blockRe.exec(html)) && results.length < count) {
        const anchor = m[0];
        const hrefM = anchor.match(/href="([^"]+)"/);
        const rawUrl = hrefM ? hrefM[1].replace(/&amp;/g, "&") : "";
        const uddg = rawUrl.match(/uddg=([^&]+)/);
        const url = uddg ? decodeURIComponent(uddg[1]) : rawUrl;
        const title = m[1].replace(/<[^>]+>/g, "").trim();
        // snippet follows the title anchor inside the same result block
        const blk = html.slice(m.index, m.index + 2500);
        const snM = blk.match(/class="result__snippet"[^>]*>(.*?)<\/a>/s);
        const snippet = snM ? snM[1].replace(/<[^>]+>/g, "").trim() : "";
        results.push(`${title}\n  ${url}\n  ${snippet}`);
      }
      const text = results.length ? `${results.length} results:\n\n${results.join("\n\n")}` : "No results.";
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `web_search failed: ${e.message}` }] };
    }
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
      const tmpMp3 = join(STATE_DIR, "jarvis-tts.mp3");
      run("edge-tts", ["--voice", "en-US-ChristopherNeural", "--text", text, "--write-media", tmpMp3]);
      execFileSync("ffplay", ["-nodisp", "-autoexit", tmpMp3], { stdio: "ignore", windowsHide: true });
      return { content: [{ type: "text", text: "Spoke (edge-tts)." }] };
    }
    // Default: use piper via the speech server or direct CLI
    const piperExe = join(JARVIS_DIR, "venv", "Scripts", "piper.exe");
    const sayScript = join(JARVIS_DIR, "bin", "say.ps1");
    if (existsSync(sayScript)) {
      try {
        execFileSync("powershell", ["-NoProfile", "-File", sayScript, text], { stdio: "ignore", timeout: 60000, windowsHide: true });
        return { content: [{ type: "text", text: "Spoke (piper)." }] };
      } catch (e) {
        return { content: [{ type: "text", text: `TTS failed: ${e.message}` }] };
      }
    }
    // Fallback: use Windows built-in speech synthesis
    try {
      const psScript = `Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; $synth.Speak('${text.replace(/'/g, "''")}')`;
      execSync(`powershell -NoProfile -Command "${psScript}"`, { stdio: "ignore", timeout: 30000, windowsHide: true });
      return { content: [{ type: "text", text: "Spoke (Windows TTS)." }] };
    } catch (e) {
      return { content: [{ type: "text", text: `TTS failed: ${e.message}` }] };
    }
  }
);

// ---------------------------------------------------------------- main
const transport = new StdioServerTransport();
await server.connect(transport);
