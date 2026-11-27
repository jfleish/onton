# Studio real-run acceptance result

## Result: NOT VERIFIED

The Electron Studio real-mode failure path is validated, but a successful real `onton --headless` agent run cannot be safely completed with the current production CLI in a local-only fixture.

## Established dependency

A fresh gameplan run requires:

1. `bin/main.ml` parses the gameplan owner/repo and calls `Managed_repo.ensure_managed_repo`.
2. The managed checkout is cloned from the selected forge target; `--repo-root` is explicitly ignored when `--gameplan` is supplied.
3. `Resolved_config.validate_resolved_config` requires a non-empty forge token.
4. GitHub forge operations use the hard-coded `https://api.github.com` endpoint in `lib/github.ml`.
5. Worker completion proceeds into forge/publication operations, so a local bare Git remote alone is insufficient for a real successful agent run.

The coordinator acceptance fixture can emulate forge/resource operations because `onton-coordinator` accepts explicit `--forge-helper` and `--resource-helper` processes. The `onton --headless` Studio entrypoint has no equivalent forge-helper or API-endpoint injection, and production authentication/safety must not be bypassed with a fake token or monkey-patched network route.

## Studio evidence

- Guarded real mode is exposed only with `ONTON_STUDIO_ENABLE_REAL=1`.
- Electron launched the actual built `main.exe` with fixed arguments, isolated data, and control endpoint environment.
- A disposable invalid gameplan produced `mode=real`, `run_status=failed`, persisted stderr, and persisted lifecycle events.
- Default Studio mode remains local/simulation-only.

## Smallest missing capability

Add a production-supported, test-only forge boundary for headless runs—preferably an explicit local forge adapter or injectable GitHub API base URL plus local publication mode—with authentication and mutation policy enforced at that boundary. Do not simulate success from Electron or weaken GitHub authentication to make this fixture pass.

Until that capability exists, Studio real mode remains guarded opt-in and is not reported as successfully agent-validated.
