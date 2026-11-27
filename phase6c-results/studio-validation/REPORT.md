# Onton Studio validation

- local-discovery: Local adapter
local · Idle
- gameplan: Execution map
- agents: Agents in the loop
- timeline: What happened
- transcript: Agent conversations
- approvals: Execution gate
- real-gameplan-graph: 4 nodes
- local-run-lifecycle: running -> cancelled
- approval-gate: disabled
- responsive-900: pass overflow=0

- console/page errors: 0


## Scope

- Real local project discovery and Git metadata: connected.
- Local persisted run lifecycle and event stream: connected.
- Coordinator, worker, Codex execution, approvals, pushes, and merges: disabled.
- Disposable coordinator/worker fixture attempt: blocked on the existing Unix-only fixture (`/tmp` path and Unix process assumptions) under Windows; no repository or forge mutation occurred.
- Focused OCaml regressions: backend smoke, process cancellation, worker Git recovery, and persistence properties all passed.
