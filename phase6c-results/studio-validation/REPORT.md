# Onton Studio validation

- local-discovery: Local adapter
- simulated · Cancelled
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
- Local persisted simulation lifecycle and event stream: connected.
- Guarded real mode exposes a distinct real Onton action only with `ONTON_STUDIO_ENABLE_REAL=1`.
- Real-mode invalid-gameplan lifecycle was exercised through the actual built `main.exe`: process failure and stderr events persisted.
- Coordinator, worker, Codex success execution, approvals, pushes, and merges remain disabled by default.
