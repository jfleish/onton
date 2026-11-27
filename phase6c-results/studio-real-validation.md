# Studio real-mode validation

- `ONTON_STUDIO_ENABLE_REAL=1` exposes a distinct `Run real Onton` action.
- The Electron main process launches the built `main.exe` with fixed argv, `shell:false`, isolated `ONTON_DATA_DIR`, and `ONTON_CONTROL_SOCKET`.
- JSONL stdout/stderr are parsed and persisted through the narrow preload adapter.
- A disposable invalid gameplan exercised the real `onton --headless` failure path: `mode=real`, `run_status=failed`, persisted stderr/failure events.
- Default Studio mode remains local/simulation-only.

A successful real agent run and real-run cancellation were not claimed: a safe no-forge local `onton --headless` success fixture is not available because gameplan startup prepares a managed forge checkout. Real mode therefore remains explicitly opt-in and approvals/forge mutations remain disabled.
