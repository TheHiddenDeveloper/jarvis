# Jarvis Memory

Persistent long-term knowledge. This survives across sessions and conversations — it's how Jarvis "remembers."

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

## Quick-reference topics

| Topic | Purpose |
|---|---|
| `preferences` | How the human likes things done |
| `people` | Names, roles, relationships, contact facts |
| `projects` | Active projects and their state |
| `facts` | Durable facts about the human's life/context |
| `tasks` | Outstanding/in-flight tasks (not one-off requests) |
| `decisions` | Significant past decisions and their rationale |
