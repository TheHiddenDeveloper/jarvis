# Jarvis Vault — Agent Guide

This is **Jarvis's own Obsidian vault** (`~/jarvis/vault`), separate from the human's
personal vault (`~/Ideaverse`). It holds everything Jarvis learns about this machine
and its screen, so the human's notes are never touched by automation.

This is **not** the Ideaverse. The Ideaverse is the human's canonical brain. Do not
write Jarvis operational knowledge there, and do not treat this vault as the human's
knowledge base.

## What lives here

| Area | Purpose |
|------|---------|
| `Procedures/<task>.md` | Multi-step desktop task SOPs (how to do X). Written by `save_procedure`. |
| `Screen/Landmarks.md` | Stable UI element positions (% of screen). Written by `record_landmark` or `click_on` with a `name`. |
| `Knowledge/` | Learned facts about the machine, apps, or how the screen behaves. Written with `memory_write`/direct files. |

## Conventions

- **Directories**: PascalCase, single word (`Screen`, `Procedures`, `Knowledge`).
- **Note files**: kebab-case, no spaces, `.md` suffix.
- **Landmarks**: coordinates are percentages (0–100) of the full screen, recorded
  with the resolution they were captured at — re-verify when the resolution changes.
- **Procedures**: always carry a Trigger phrases section (used for recall), per-step
  Expected state (used for verification), and Failure handling.
- **Frontmatter**: `title`, `status: active`, `created`, `last_verified`, `tags`.

## Fast index

The fast-access index `~/jarvis/memory/procedures.md` maps trigger phrases to
procedure titles. `memory_search`/`memory_read` check it first; the full note lives
here in the vault. Store a fact once — reference, don't duplicate.

## Recall loop

Before running a multi-step desktop task: search this vault for a matching procedure
and relevant landmarks, then follow it step-by-step, verifying each expected state
with a screenshot. On success, refresh `last_verified`; if the steps changed, update
the procedure.
