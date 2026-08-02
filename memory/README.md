# Jarvis Memory

Persistent long-term knowledge. This survives across sessions and conversations — it's how Jarvis "remembers."

## Two layers

1. **Canonical brain — Obsidian vault** (`~/Ideaverse`): durable knowledge about the human's life and work lives here as notes. Tools: `vault_read`, `vault_search`, `vault_write`, `vault_context`, `vault_log`.
2. **Fast-access layer — this folder** (`~/jarvis/memory/`): small curated topic files for operational state and quick recall. Tools: `memory_read`, `memory_write`, `memory_search`.

Rule: store a fact once. If it belongs in a vault area, write it there (`vault_write`/`vault_log`) and reference it from here — don't duplicate into both places.

## Rules

1. **One topic per file.** Files live here, lowercase with dashes: `people.md`, `preferences.md`, `projects.md`, `facts.md`, `tasks.md`, `decisions.md`. Create new topics as needed.
2. **Timestamp every entry.** Use `[YYYY-MM-DD]` prefixes so we know when a fact was recorded and can prune stale ones.
3. **Concise, structured, factual.** This is retrieval-oriented, not prose. Prefer bullet points over paragraphs.
4. **Never store secrets here.** Passwords, tokens, API keys → `~/jarvis/.env` (gitignored). Reference the variable name instead.
5. **Write what matters.** New preferences, decisions, completed significant tasks, learned constraints. Don't log trivia.
6. **Review occasionally.** If a topic grows beyond ~200 lines, split or prune. The agent may do this during quiet moments.

## Tools

The `jarvis-tools` MCP server exposes:

- `memory_read(topic)` — get the contents of a topic file.
- `memory_write(topic, content)` — append an entry (prefixed with the current date).
- `memory_search(query)` — full-text search across all topic files.

For the Ideaverse vault (canonical brain):

- `vault_read(note)` — read a note by path or wikilink.
- `vault_search(query)` — full-text search across the vault.
- `vault_search_semantic(query)` — meaning-based search via local embeddings (index auto-built on first use; incremental re-index by mtime).
- `vault_write(note, content)` — create or append a dated section to a note.
- `vault_context()` — print vault state snapshot (tasks, daily note, reports).
- `vault_log(title, desc, ...)` — log a Post-Flight entry to today's daily note + reports.

## Quick-reference topics

| Topic | Purpose |
|---|---|
| `preferences` | How the human likes things done |
| `people` | Names, roles, relationships, contact facts |
| `projects` | Active projects and their state |
| `facts` | Durable facts about the human's life/context |
| `tasks` | Outstanding/in-flight tasks (not one-off requests) |
| `decisions` | Significant past decisions and their rationale |
