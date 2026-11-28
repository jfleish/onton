# Onton Studio v0.1.0 release readiness

Date: 2026-11-28
Branch: `studio-development`

## Assessment

**INTERNAL BETA LIMITED GO / REAL-PROJECT NO-GO / PUBLIC BETA NO-GO.** The installed NSIS build and portable build load the packaged Electron frontend and bundled native OCaml engine, and independent real Codex tasks work. The internal beta evaluation found unresolved dependency-worktree and restart-recovery failures on a real multi-task project. No public release was published. See `docs/studio-internal-beta-report.md`.

## Packaged acceptance

| Check | Result | Evidence |
| --- | --- | --- |
| Installer build | PASS | `dist-electron/Onton-Studio-0.1.0-x64.exe` |
| Portable build | PASS | `dist-electron/Onton-Studio-0.1.0-x64-portable.exe` |
| Bundled native files | PASS | `packaging/native/win32-x64/manifest.json` |
| Unpacked packaged launch | PASS | `phase6c-results/packaged-smoke/` |
| Installed launch | PASS | `phase6c-results/installed-final-smoke/` |
| Installed bundled gameplan validation | PASS | 3 tasks returned through CDP |
| Portable dependency detection | PASS | Git, Codex, and `codex login status` detected |
| Portable real Codex run | PASS | 2 independent tasks ran concurrently; task 3 waited |
| Commits/artifacts/transcripts | PASS | commits `68ed1b5`, `bdd2c94`, `e3d7f07`; A/B/C artifacts and transcripts present |
| Authenticated cancellation | PASS | Onton process tree exited; run persisted as cancelled |
| Restart recovery (prior acceptance) | PASS | cancelled run history reopened after portable restart |
| Internal beta dependent run | FAIL | `docs/studio-internal-beta-report.md`; task 3 blocked because dependency commits were not materialized into its base |
| Internal beta restart recovery | FAIL | durable evidence survived, but run was fenced as failed after restart without attachable Onton process |
| Uninstall repository safety | PASS | disposable repository SHA-256 inventory unchanged |
| Automated acceptance script | PASS (development host only) | `scripts/accept-studio-windows.ps1`; installer/native/dependency/validation/uninstall/repository checks passed |
| Clean-machine VM | SKIP | no disposable Windows VM or isolated runner available; do not treat development-host PASS as VM acceptance |

Portable real-run evidence is under `phase6c-results/portable-final-acceptance/`. The control endpoint observed during the run was loopback TCP with a 256-bit token. No external forge operations were enabled; the profile was local-only. The automated acceptance output is under `phase6c-results/clean-acceptance-final/`; it passed on this development host only and explicitly recorded `clean-machine-isolation: SKIP`.

## Security/reliability audit

Focused fixes in the release candidate:

- Packaged executable resolution uses `process.resourcesPath/native/win32-x64`; developer paths remain fallback-only.
- Codex `.cmd`/PowerShell shims are detected without exposing credentials to the renderer.
- IPC handlers now reject senders other than the application window's renderer.
- Persisted runtime directories and control endpoints are constrained to the per-user `real-runs` directory and current project key.
- TCP control endpoints require loopback hosts, valid ports, and a token; named endpoint paths remain inside the trusted run directory.
- Project and run persistence uses atomic writes with restrictive file mode requests.
- Renderer-visible transcript/event text and Electron stderr projection redact common GitHub/OpenAI/Codex token prefixes.
- Quit waits through the cancellation path before requesting Electron exit.
- Native process execution remains shell-free; Windows cancellation retains the existing `taskkill /T /F` fallback.

The OCaml engine remains authoritative for scheduling, dependency gates, worktrees, Git operations, persistence, recovery, cancellation, and execution decisions.

## Checksums

Installer:

```text
9D25A7244859582BE5F2888568A3DFEAB1AD0B032463FF79D297191E8A23F2F3  Onton-Studio-0.1.0-x64.exe
863037A2BEE7145F867BFF69DFB272C5BD5D36440CD7A840D62F199CC83492CD  Onton-Studio-0.1.0-x64-portable.exe
```

Native payload:

```text
262CF40AE491AE34B7E31B96AACAEDD055E8641F7D3E327DB896659C58C81767  onton.exe
FAD52F02570F70CB6C2D8805779FA70736A64DC218F63B700DBD9F6399E2144B  onton-coordinator.exe
7797992FB7980B8502A6BDC9536E6EF1E0AFB6953F83BDC6C5E31B8E921823F1  onton-worker.exe
C5EDF68200440B62D1F255903B3DC9BFC004028EF5216703EE7F9235CD4A7432  onton-setsid-exec.exe
37248CDA33845E7C5C35A574E57DA762DD0A8268F0270D179F30A33746809681  libgmp-10.dll
```

## Dependency audit

`npm audit` initially reported 18 findings, including high-severity build-tool transitive issues in the older electron-builder tree. Upgrading electron-builder to `26.18.1` and pinning safe transitive versions with npm overrides (`minimatch 11.0.9`, `fast-xml-parser 5.12.1`) reduced the final audit to **0 vulnerabilities**. `npm run studio:check`, `npm run studio:build`, and `npm run studio:package` passed with the upgraded tree.

The audit covers development/package tooling as well as runtime dependencies. Re-run `npm audit` before each beta artifact rebuild because the upstream advisory database and transitive ranges change independently of the application source.

## CI and beta gates

The Windows release workflow now runs Studio TypeScript checks, packages installer/portable outputs, checks the bundled engine and DLL, generates SHA-256 checksums, and uploads the packages as CI artifacts. The automatic GitHub Release and Homebrew push jobs were removed; CI does not create, publish, or push a release artifact. Artifact upload uses the workflow token only for Actions artifact storage.

The acceptance script is `scripts/accept-studio-windows.ps1`. It installs the NSIS package into a temporary isolated path, checks every native resource, launches through CDP without setting a developer engine path, validates a canonical plan, checks dependency status, uninstalls, and compares a SHA-256 repository inventory. It is suitable for a clean Windows runner; this machine is not an isolated VM.

Before public beta:

1. Run the same installer and portable acceptance on an isolated clean Windows x64 VM.
2. Verify Git for Windows and Codex installation/authentication guidance on that VM.
3. Obtain code-signing credentials and sign the installer/native payload, or explicitly accept SmartScreen warnings for an internal beta.
4. Review Electron-builder/npm dependency advisories before distribution.
5. Obtain an Authenticode code-signing certificate for the publisher identity, protect the private key in CI secret storage, configure electron-builder signing with authorized credentials, and verify the signed installer/native payload and timestamp. No certificate was purchased or used here.
6. Keep generated installers outside Git and publish only after explicit authorization.
