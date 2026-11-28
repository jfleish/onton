# Onton Studio Windows packaging

Onton Studio is an Electron presentation layer around the native OCaml Onton engine. Electron never replaces scheduling, worktrees, Git policy, persistence, recovery, cancellation, or agent lifecycle decisions.

## Build

Prerequisites for maintainers only:

- Windows x64
- OCaml/opam/Dune switch used by this checkout
- Node.js/npm for the packaging build
- Git for Windows (also required by installed users)
- A Codex CLI installation and authentication for real Codex runs

```powershell
$env:DUNE_CACHE = 'disabled'
opam exec -- dune build bin/main.exe bin/coordinator.exe bin/worker.exe bin/setsid_exec/main.exe
npm ci
npm run studio:package
```

`studio:package` creates an unsigned NSIS installer and portable executable under `dist-electron/`. Generated installers and staged native files are ignored and are not committed or published.

For a directory smoke build:

```powershell
npm run studio:package:dir
```

## Bundled native inventory

`npm run studio:stage-native` copies only the runtime payload into `packaging/native/win32-x64/`:

- `onton.exe` — main OCaml engine and canonical gameplan/runtime authority
- `onton-coordinator.exe` — distributed coordinator helper
- `onton-worker.exe` — distributed worker helper
- `onton-setsid-exec.exe` — Windows process-tree supervisor
- `libgmp-10.dll` — MinGW runtime dependency
- `manifest.json` — SHA-256 inventory generated at staging time

The staged executable names intentionally match the existing OCaml sibling lookup (`onton-setsid-exec`) and the Studio packaged path. No compiler, opam switch, Dune tree, test fixture, or development helper is bundled.

## Runtime paths and writable data

Packaged native files are resolved from Electron's `process.resourcesPath/native/win32-x64`. Development builds retain the existing `_build/default/bin` fallback. Studio state and run data are written under Electron's per-user `app.getPath('userData')`; repositories are never installed into or modified by the installer. NSIS is per-user by default and uninstall preserves user data and repositories.

The installer does not bundle Git or Codex. Studio reports missing Git/Codex dependencies and gives actionable install/restart guidance. Credentials remain in the main process environment and are never exposed to the renderer.

## Security and limitations

The installer is intentionally unsigned because signing credentials are not available. Windows SmartScreen may warn until a signed distribution is authorized. Clean-machine VM acceptance is not available in this checkout; local packaged-directory and artifact smoke checks are therefore reported separately from clean-machine validation.

The existing Electron sandbox, context isolation, disabled Node integration, denied window opens, shell-free native spawning, authenticated Onton control transport, gameplan validation boundary, and local-only forge profile remain in force.
