#!/usr/bin/env bash
# Fire due Jarvis reminders from the same state/reminders.json the MCP tools use.
# Safe to run from a systemd user timer or cron every minute.
set -euo pipefail

REMINDERS_FILE="$HOME/jarvis/state/reminders.json"
[ -f "$REMINDERS_FILE" ] || exit 0

node - "$HOME/jarvis/state/reminders.json" <<'EOF'
const fs = require("fs");
const file = process.argv[2];
const now = Date.now();
const list = JSON.parse(fs.readFileSync(file, "utf8"));
let changed = false;
for (const r of list) {
  if (r.at && r.at <= now && !r.done) {
    r.done = true;
    changed = true;
    try {
      require("child_process").execFileSync("notify-send", ["\u23f0 Reminder", r.text]);
    } catch {}
    console.log(r.text);
  }
}
if (changed) fs.writeFileSync(file, JSON.stringify(list, null, 2));
EOF