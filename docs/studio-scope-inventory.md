# Onton Studio scope inventory

## Baseline comparison

Compared with `upstream/main`, `studio-development` contains three categories:

| Category | Retained scope | Notes |
| --- | --- | --- |
| Core Onton | Gameplan parsing, scheduler, dependency admission, worktrees, persistence/recovery, cancellation, GitHub/SourceHut publication/review, and Claude/Codex/OpenCode/Pi/Gemini backends | OCaml remains authoritative. No scheduling or forge logic moved into Electron. |
| Windows compatibility | Native process-tree/job-object handling, Windows pipe/socket stubs, PATH/process discovery, MinGW packaging, native coordinator/worker wiring, and Windows cleanup tests | These changes are required for native Windows operation without WSL. |
| Electron Studio | Project/gameplan selection, canonical validation, runtime configuration, start/stop, live projection, transcripts/events/artifacts/commits, and dependency graph navigation | Electron is a thin IPC/rendering layer over the existing CLI and persisted runtime. |
| Optional local profile | `--forge local`, exact prerequisite materialization, local completion HEAD persistence, and local-only acceptance tests | Kept isolated behind `Forge.name = "local"`; GitHub and SourceHut paths remain unchanged. |

## Scope reductions

- Removed the Studio simulation IPC/API from the production surface; the desktop now starts the real Onton headless process or remains idle.
- Removed Codex/local-only validation from Studio configuration. Backend choices are Claude, Codex, OpenCode, Pi, and Gemini; forge choices are auto, GitHub, SourceHut, and optional local.
- Kept the graph as presentation only. It consumes projected task/dependency state and never schedules, merges, publishes, or infers completion from transcript text.
- Retained the local profile because it is an explicit CLI/runtime mode with focused tests and does not alter remote forge semantics.

## Before / after

**Before this scope pass:** Studio configuration accepted only Codex plus local forge, and a simulation IPC path was exposed alongside the real runner. The recent graph implementation was UI-only but the adapter types reflected those restrictions.

**After this scope pass:** Studio exposes the original backend and forge families, uses the real headless CLI as its execution path, preserves the native Windows engine and packaged resources, and keeps local dependency integration optional and isolated. No release was published and `main` was not changed.

## Validation boundary

The development-host checks cover native process/pipe behavior, backend preflight, gameplan parsing, worktree integration, cancellation, TypeScript, and packaged resource presence. No new real GitHub or SourceHut publication is claimed by this scope pass; those flows remain available through the original CLI and require authenticated disposable-repository acceptance before claiming end-to-end success.
