# Onton Studio integration architecture audit

**Repository:** `C:\Users\josep\onton-windows`  
**Branch:** `studio-development`  
**Audit scope:** read-only source audit; no production source changes and no full test-suite run.

## Executive recommendation

The shortest safe path is **not** a new Studio orchestration engine and not a new Forge abstraction. Onton already has the complete agent lifecycle in the CLI runtime:

```
CLI/config -> gameplan parser -> managed checkout -> resolved runtime
  -> Runtime/Orchestrator -> Worktree_setup -> Session_driver
  -> selected LLM backend -> checkpoint/event/transcript persistence
  -> branch reconciliation -> Forge publication/CI/review/merge observation
```

Studio should become a thin, main-process supervisor and read model for that existing runtime. The current Electron adapter already has the correct security boundary and a useful guarded process launcher, but it launches `bin/main.exe` without a supported local forge mode and then reconstructs state from heuristic JSONL messages. The missing capability is a **safe, explicit local execution/publication policy**, not another coordinator or agent abstraction.

Recommended minimal path:

1. Reuse the existing `main.exe --headless --headless-transcript --no-refresh` entrypoint and existing `Runtime`, `Orchestrator`, `Session_driver`, `Worktree`, backend, and persistence code.
2. Add a narrowly scoped **local forge implementation or local forge execution profile** at the existing `Forge.S` boundary. It must use disposable local bare remotes and explicit local CI/review/merge observations, never production GitHub credentials or endpoint fallbacks.
3. Make the headless output and control endpoint the stable Studio contract. Prefer structured lifecycle records and a control-client API over parsing human activity strings.
4. Let Electron pass explicit backend/forge/profile configuration, supervise the process tree, and render persisted state. Do not duplicate scheduling, worktree, retry, publication, or recovery logic in JavaScript.
5. Keep real mode explicitly opt-in until a disposable local fixture proves successful task execution, transcript delivery, cancellation, cleanup, persistence, and restart recovery.

This is the smallest change that can produce a real Codex agent run without weakening production authentication or inventing a parallel orchestration engine.

---

## 1. Architectural map

### 1.1 CLI and configuration entrypoint

`bin/main.ml` is the real application entrypoint. Cmdliner exposes project/gameplan, forge, token, backend, model, repository, branch, worktree, concurrency, headless, transcript, and lifecycle flags (`bin/main.ml:1864-1990`, with the `run` wiring at `1590-1782`). The command supports:

- a fresh/ad-hoc project (`--repo` or current directory, no gameplan);
- a gameplan project (`--gameplan`);
- resume by stored project name;
- ad-hoc `+PR`, `+BRANCH`, and `-PR` operations;
- `--headless` and `--headless-transcript` modes.

**Verified fact:** an ad-hoc run without a gameplan creates an empty gameplan (`bin/main.ml:531-580`). It is useful for project/config initialization but cannot exercise a real patch agent until patches are added through an existing project/gameplan path.

`resolve_config` claims the project, loads or creates the repo configuration, resolves backend/model, validates execution mode, and persists the project configuration (`bin/main.ml:1590-1726`). `run_with_config` then validates the resolved repository branch, raises file-descriptor limits, builds the runtime, restores execution mode, constructs capabilities, builds fibers, and enters `run_main_loop` (`bin/main.ml:1492-1574`).

### 1.2 Gameplans, graph, and workstreams

Gameplans are parsed by `Gameplan_parser` and converted into an `Orchestrator` graph (`lib/coordinator_runtime.ml:26-35`; the main path parses and validates at `bin/main.ml:581-665`). The graph carries patches, dependencies, branch identity, complexity, publication metadata, and patch-agent state. `Execution_mode` distinguishes mainline and feature-root behavior (`bin/main.ml:1535-1558`, `1740-1778`).

The main runtime does not need Studio-specific task scheduling. `Orchestrator`, `Graph`, `Patch_agent`, `Patch_decision`, and `Runner_fiber_impl` already own dependency readiness, agent state, operation kinds, human guidance, publication operations, and completion transitions.

`studio/main.cjs:48-66` currently reads only a JSON `patches` array and fabricates task IDs/status from persisted Studio state. It does not parse YAML, use `Gameplan_parser`, resolve dependency semantics, or observe the Onton graph. This is a read-model shortcut, not a second scheduler; it should remain a presentation adapter or be replaced by headless structured state.

### 1.3 Backend selection and agent execution

`lib/backend_registry.ml:28-88` is the existing backend factory/cache and auto-model router. It supports:

- Claude (`Claude_backend` / `Claude_runner`);
- Codex (`Codex_backend`);
- OpenCode (`Opencode_backend`);
- Pi (`Pi_backend`);
- Gemini (`Gemini_backend`).

The common `Llm_backend.t` contract is a streaming process invocation with project, cwd, patch ID, prompt, optional resume session, session UUID, complexity, event callback, and a normalized result (`lib/llm_backend.ml:363-374`). The process layer owns stdout/stderr streaming, idle timeout, bounded capture, terminal-event handling, cancellation, and platform-specific cleanup (`lib/llm_backend.ml:16-356`).

Backend-specific behavior is already isolated:

- Claude stream-json and model/effort options: `lib/claude_backend.ml:4-21`, `lib/claude_runner.ml:45+`, `lib_core/claude_event_parser.ml`.
- Codex JSON events, cost/usage, resume/auth-refresh behavior: `lib/codex_backend.ml:6-99`, `lib_core/codex_event_parser.ml`.
- OpenCode event normalization: `lib/opencode_backend.ml:6-45`, `lib_core/opencode_event_parser.ml`.
- Pi session/context artifacts: `lib/pi_backend.ml:6-119`, `lib_core/pi_event_parser.ml`.
- Gemini `--yolo` and resume behavior: `lib/gemini_backend.ml:6-43`, `lib_core/gemini_event_parser.ml`.

**Reuse conclusion:** Studio does not need a backend adapter for each model. It needs to choose the existing stored/CLI backend and expose normalized events produced by the existing headless fiber.

### 1.4 Session driver and task completion

`runner_fiber_impl.ml` composes `Worktree_setup`, `Session_driver`, busy guards, runtime, transcripts, and event logs (`lib/runner_fiber_impl.ml:124-162`). A normal task builds context and prompt, calls `Session_driver.run_owned`, persists completion, and then routes publication/reconciliation (`lib/runner_fiber_impl.ml:1060-1092`, `1288-1369`).

`Session_driver` owns the agent turn lifecycle: prompt creation, backend streaming, transcript collection, session identity, resume/retry, repair turns, completion classification, and publication handoff (`lib/session_driver.ml:302-459`, `525-599`, `1250-1369`).

`worker.ml` is the worker-side version of the same lifecycle. It admits a durable operation, freezes the assignment/receipt before checkout or backend work, creates a real Git worktree, restores checkpoint/session IDs, and invokes `Session_driver.Make_with_checkpoint` (`lib/worker.ml:430-501`).

**Verified fact:** the agent lifecycle already includes real task execution, transcripts, resume, completion, failure, no-commit, retry-push, recovery, and cancellation classifications. Duplicating it in Electron would be a major correctness and recovery regression.

### 1.5 Git worktrees and branch execution

The `Worktree.S` contract covers deterministic worktree paths, main-root resolution, branch/ref checks, ancestry planning, creation, fetch serialization, push result parsing, and cleanup (`lib/worktree.mli:6-87`, `81-180`). `Worktree_setup` adds ownership, expected-HEAD checks, hooks, reinspection, and recovery (`lib/worktree_setup.ml:70-117`, `141-204`, `229-298`).

`Branch_reconcile` and `Branch_reconcile_runner` own branch reconciliation and integration evidence. The runtime has explicit mainline/feature mode validation and refuses unsupported feature configurations (`bin/main.ml:1740-1760`).

**Local feasibility:** local Git worktrees and a bare remote are technically sufficient for branch creation, commits, ancestry, and push. They are not sufficient for the current default gameplan flow because the gameplan path insists on an Onton-managed checkout selected from the forge identity (`bin/main.ml:621-665`) and the downstream Forge interface includes review, CI, PR, and merge observations.

### 1.6 Coordinator/worker lifecycle

The distributed path is a separate executable boundary, not required by the single-process CLI path.

`bin/coordinator.ml:87-149`:

- decodes config and gameplan;
- requires repository identity and non-empty patches;
- requires an executable resource helper;
- verifies the checkout and directly observable origin main branch;
- selects either `--forge-helper` or production GitHub;
- calls `Coordinator_bootstrap.start` and `Coordinator_runtime.run`.

`lib/coordinator_runtime.ml:26-84` owns coordinator state, authority epoch/revision, resource requests, stop requests, event processing, and the injected `Forge.S` module. `lib/worker.ml:145-269` handles protocol admission, host loss, cancellation, checkpoint validation, and operation status. The v2/v3 protocol and coordinator store provide versioned CAS-like persistence, capsules, receipts, and takeover/recovery.

**Important distinction:** the distributed coordinator already has a local test seam (`--forge-helper`). The main `onton --headless` path does not expose that seam. Studio currently launches `main.exe`, not `onton-coordinator.exe`.

### 1.7 Persistence, events, transcripts, and control

Persistence is split across several intentionally different layers:

- atomic snapshot writes use temporary files, flush/fsync/rename behavior (`lib/persistence.ml:9-33`);
- `Runtime.update_persisting` persists before publishing the in-memory update, while ordinary runtime updates are memory-only (`lib/runtime.ml:88-121`);
- periodic persistence copies transcripts and saves snapshots approximately every five seconds (`lib/persistence_fiber.ml:18-40`);
- `Event_log` persists normalized Poll/Action/Complete events, not every raw stream/spawn event (`lib/event_log.ml:110-160`);
- session artifacts retain raw backend/session material (`lib/session_artifacts.ml`);
- startup reconciliation restores runtime and worktree state (`lib/startup_reconciler.ml:30-74`, `88-119`; `bin/main.ml:1064-1145`).

The headless protocol is JSONL. `lib/headless_fiber.ml:38-123` emits activity records and transcript deltas with `source`, timestamp, optional patch ID, and message; transcript chunks are capped at 4 KiB and use byte offsets to avoid duplicate emission.

Control commands are versioned/idempotent in `lib_core/control_command.ml:4-70` and applied durably by `lib/control_server.ml:26-112`. Unix authenticates using peer UID; Windows uses a loopback TCP endpoint, owner-only endpoint directory, a random token, and endpoint metadata (`lib/control_server.ml:15-24`, `136-193`, `195-219`).

**Integration gap:** the headless stream is a useful activity/transcript feed, but it is not a complete state protocol. Studio currently infers agent status by regex over human messages (`studio/main.cjs:100-112`) and does not consume control endpoint metadata or issue typed control commands.

### 1.8 Forge integration

`Forge.S` is already the right abstraction for production forge behavior. It covers branch/PR state, CI checks and failure details, reviews, PR creation/update, draft/review operations, merge/enqueue/dequeue, and access checks (`lib/forge.mli:4-145`). `bin/main.ml:931-970` constructs either `Sourcehut.make` or `Github.make` from resolved credentials.

The GitHub implementation uses a fixed `https://api.github.com` base (`lib/github.ml:1178-1201`) and the token is required by resolved configuration (`lib/resolved_config.ml:48-90`). Git authentication is installed through `Git_env` and managed checkout logic (`lib/managed_repo.ml:181-268`; `lib/git_env.ml`).

Gameplan execution through `--gameplan` explicitly ignores user `--repo` and calls `Managed_repo.ensure_managed_repo` based on gameplan owner/repo (`bin/main.ml:621-665`). The local/ad-hoc path can operate on a repository path, but it creates an empty gameplan and therefore does not provide a real patch-agent task (`bin/main.ml:531-580`, `1923-1929`).

**Exact forge/publication boundary:**

1. gameplan owner/repo must pass target validation (`bin/main.ml:592-620`);
2. the managed checkout is cloned/fetched from that forge identity (`bin/main.ml:640-651`, `lib/managed_repo.ml:181-268`);
3. a non-empty token is required by resolved config (`lib/resolved_config.ml:62-69`);
4. the runtime constructs the real Forge module (`bin/main.ml:931-970`);
5. session completion can push/reconcile and create/update publication objects (`lib/runner_fiber_impl.ml:1092-1209`, `lib/session_driver.ml:1288+`);
6. coordinator startup explicitly calls `Forge.check_repo_access` (`bin/coordinator.ml:117-120`), and scheduler/worker paths observe PR/CI/review state through `Forge.S`.

A local bare Git remote handles only part of step 2 and Git branch mutation. It does not implement API access, PR identity, review state, CI observations, merge queue evidence, or publication semantics.

---

## 2. Existing versus missing functionality

| Capability | Existing implementation | Studio can expose now | Missing for supported real Studio |
|---|---|---:|---|
| Gameplan parsing/graph | `Gameplan_parser`, `Graph`, `Orchestrator` | Read-only task view if launched with explicit gameplan | Structured task/state feed instead of JSON/regex discovery |
| Scheduling/dependencies | `Orchestrator`, `Patch_decision`, runner fibers | No need to duplicate | None in engine; adapter needs projection |
| Codex/other backends | `Backend_registry` + backend/event parsers | Select existing backend via config | Explicit Studio configuration UX/validation |
| Git worktrees | `Worktree`, `Worktree_setup`, reconciliation | Display branch/path/events | Safe local forge/profile for complete lifecycle |
| Agent sessions | `Session_driver`, `Llm_backend` | Launch existing `main.exe` | No new agent engine needed |
| Coordinator/workers | `onton-coordinator`, `onton-worker`, v2/v3 protocol | Existing distributed acceptance | Studio currently does not launch/attach coordinator path |
| Activity events | `headless_fiber` JSONL | Parse and display | Structured status/state records |
| Transcripts | `headless_fiber`, session artifacts, persistence | Display chunks | Resume/offset/agent identity contract in adapter |
| Persistence/recovery | Runtime snapshots, event log, startup reconciler | Persist Studio process summary | Attach/reconcile an existing Onton process; current recovery only fences missing real process |
| Control | Unix socket / Windows authenticated TCP; idempotent commands | None beyond stop process tree | Typed control client, endpoint discovery, command responses |
| Cancellation | Runtime cancellation and process-tree cleanup | Electron `taskkill`/SIGTERM | Graceful Onton control cancellation before forced kill |
| Forge GitHub/SourceHut | Full `Forge.S`, GitHub, SourceHut | No safe local mode | Local forge adapter/profile or an explicitly supported local API endpoint |
| Approvals | Engine control/human guidance semantics exist | UI can show disabled gate | Typed approval/control projection; no automatic forge mutation |
| Security | Electron sandbox/context isolation; native process cleanup | Already preserved | Do not pass credentials through renderer; local endpoint ACL/token hardening |

---

## 3. Studio adapter comparison

### Current Electron boundary

`studio/main.cjs:13-46` correctly keeps filesystem, Git, persistence, and child-process ownership in Electron main. The BrowserWindow has `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, and denies new windows (`studio/main.cjs:180-183`). `studio/preload.cjs:3-14` exposes a narrow typed bridge; `studio/src/adapter.ts:35-62` mirrors it.

The current real launcher:

- requires `ONTON_STUDIO_ENABLE_REAL=1`;
- requires `ONTON_STUDIO_GAMEPLAN`;
- finds the built executable;
- sets isolated `ONTON_DATA_DIR`, `ONTON_CONTROL_SOCKET`, and run marker;
- launches `--gameplan ... --headless --headless-transcript --no-refresh` with `shell:false`;
- captures stdout/stderr and persists a Studio summary (`studio/main.cjs:127-164`).

These are good lifecycle/security choices and should be retained.

### Current gaps

1. **No supported local forge selection.** The launcher does not pass a forge/profile/backend/token configuration; it inherits environment and invokes the production gameplan path.
2. **No structured agent state.** `onHeadlessRecord` turns message text into `working/idle/blocked` with regex (`studio/main.cjs:100-112`). It can misclassify messages and cannot represent retries, leases, completion receipts, CI state, or recovery tickets.
3. **No control client.** `controlPath` is stored in Studio state but never read. The adapter cannot send `Control_command` messages, observe authenticated responses, or request graceful cancellation/guidance.
4. **Cancellation is process-level only.** `stopRun` uses `taskkill /T /F` on Windows or SIGTERM (`studio/main.cjs:166-178`). This is useful as a final safety fence, but it skips the Onton control protocol and may prevent graceful checkpointing.
5. **No attach/recovery.** On restart, persisted real `running` state is marked failed because there is no attachable process (`studio/main.cjs:27-35`). That is safe fencing, not recovery/reattachment.
6. **Output tail risk.** The stdout handler buffers a partial final line, but `onRealExit` does not flush that buffer (`studio/main.cjs:153-162`, `118-125`). A final JSONL record without a newline can be lost.
7. **Task discovery is narrower than Onton.** Studio reads JSON only and assumes a `patches` array (`studio/main.cjs:48-66`), while the CLI accepts YAML and the canonical parser handles full gameplan semantics.
8. **Snapshot typing is incomplete.** Runtime state stores `pid` and `controlPath`, but `StudioSnapshot.run` does not expose them (`studio/main.cjs:151`, `studio/src/adapter.ts:47`). This prevents a typed control/attach contract.
9. **No explicit backend selection.** Real Studio always uses the persisted/default CLI configuration rather than making Codex selection explicit and observable.
10. **No approval semantics.** The renderer can display a disabled gate, but it does not map Onton control commands, forge mutation policy, or human-message delivery into typed UI actions.

### Immediate reusable surface

Without changing the engine, Studio can immediately expose:

- project/Git metadata through current main-process discovery;
- canonical task graph by invoking or reading the canonical gameplan parser through a small main-process projection;
- selected backend/model and run configuration from persisted project config;
- activity/transcript records from `headless_fiber`;
- event-log and snapshot summaries from isolated Onton data;
- authenticated control endpoint discovery and typed guidance/automerge/bump responses;
- process-tree cancellation as a final fallback;
- persisted run fencing after restart.

---

## 4. Local execution feasibility

### Option A: reuse main CLI with a local Forge.S adapter

**Shape:** add a test/local `Forge.S` implementation and a local execution profile selected explicitly by configuration. Use a disposable bare remote, local branch/ref observations, local synthetic PR/CI/review records, and a strict no-external-network policy.

**Pros:** reuses the complete `main.exe` runtime, `Runner_fiber_impl`, `Session_driver`, worktree, persistence, and headless output. The Forge boundary is already explicit and capability-rich. A local adapter can return deterministic PR/CI/merge evidence without changing production GitHub authentication.

**Cons:** `bin/main.ml` currently constructs Forge internally from `Resolved_config`; the smallest wiring change must make the profile selectable without making production authentication optional. The local adapter must implement enough of `Forge.S` for the selected gameplan path, especially branch state, PR/publication, and CI observations.

**Assessment:** recommended. It changes the existing seam instead of introducing a second orchestration engine.

### Option B: extend the existing coordinator `--forge-helper` seam and launch coordinator/worker from Studio

**Shape:** Studio starts the coordinator executable with a local forge helper and resource helper, then observes its control/headless outputs.

**Pros:** the coordinator already accepts an explicit forge helper (`bin/coordinator.ml:134-149`), and the distributed acceptance fixture proves this seam works.

**Cons:** Studio would need to construct config/gameplan/resource helper processes, manage worker capacity, coordinate helper lifetimes, and expose a second protocol. The main CLI and coordinator would diverge. This does not exercise the simplest single-process Studio path and creates more Electron lifecycle code.

**Assessment:** useful for distributed acceptance, not the shortest path to Studio.

### Option C: local Git-only mode that skips Forge.S

**Shape:** execute agent patches in a local worktree and stop after commit/push to a bare remote.

**Pros:** small conceptual fixture.

**Cons:** it changes the semantics of `Session_driver`/publication and cannot honestly exercise current PR/CI/review/merge evidence. It would either bypass required Forge methods or create conditional branches throughout the runtime.

**Assessment:** reject. It is a new execution mode with a large semantic hole, not a safe reuse of existing behavior.

### Option D: fake GitHub server/network redirect

**Shape:** redirect GitHub clone/API calls to a test server or use fake credentials.

**Pros:** can exercise current production code superficially.

**Cons:** endpoint is hard-coded in `lib/github.ml:1200`; network interception would be test harness magic rather than an explicit application capability. It risks credentials/network confusion and does not define production authentication or policy. It is unsuitable as the supported Studio architecture.

**Assessment:** reject except as a temporary diagnostic experiment; do not use as acceptance evidence.

---

## 5. Architecture quality and platform findings

### Good reuse/boundaries

- Pure parser/decision modules are separated into `lib_core`; effectful process/FS/HTTP handlers remain in `lib`.
- Backend registry and common streaming contract prevent backend-specific process logic from leaking into orchestration.
- `Forge.S` and `Worktree.S` are genuine seams already consumed by runtime functors.
- Coordinator protocol uses durable authority/epoch/revision and receipt validation.
- Electron security settings and main-process ownership are appropriate.
- Native Windows process supervision uses handles/Job Objects (`lib/windows_process.ml`, `lib/process_tree.ml`), while Unix behavior remains separate.

### Duplication/integration debt

- Studio reconstructs task/agent state from JSON and message regex instead of consuming canonical Onton state.
- Studio owns a second run state machine (`local`, `simulated`, `real`) beside Onton runtime state.
- Process cancellation exists in backend/runtime, worker/coordinator, and Electron, but no single cross-layer cancellation contract connects them.
- Snapshot persistence, append-only event log, session artifacts, and headless JSONL are parallel representations. They are useful for different purposes, but Studio currently has no documented precedence/replay contract.
- Startup reconciliation resets persisted busy state coarsely and may discard a surviving detached worker (`startup_reconciler.ml:46-74`). This matters to future attach/recovery; do not reproduce the same behavior in Studio.

### Windows/platform assumptions to retain or address

- `Host` handles executable suffixes, user directories, environment, cleanup, and random bytes (`lib/host.ml:11-17`, `47-100`, `103-224`).
- Native Windows process handling is in `lib/windows_process.ml` and `lib/process_tree.ml`; do not replace it with shell strings.
- `Host.owner_only_dir_ok` treats a Windows directory as owner-only based on the platform convention; endpoint file ACLs should receive explicit acceptance coverage rather than being assumed from mode bits.
- `Pi` uses slash concatenation for `.pi-sessions` (`lib/pi_event_parser.ml:9-26`), which Windows accepts but is a portability smell.
- Windows command-line quoting in `windows_process.ml:31-40` deserves adversarial coverage for quotes/backslashes/trailing slashes.
- `Llm_backend` intentionally treats a Windows final backend event as success (`lib/llm_backend.ml:333-341`); this is a compatibility rule, but it should remain covered against post-final process failures.

### Maintainability recommendation

Do not add a generic `StudioOrchestrator`, duplicate backend classes, or a new event bus. Add only:

- a local forge/profile policy at the existing Forge construction seam;
- a typed headless/control contract projection;
- a thin Electron control client and read model;
- focused acceptance fixtures.

---

## 6. Exact blockers to real Studio agent execution

Ranked by shortest-path impact:

1. **No supported local Forge implementation/profile for the main CLI.** Existing local bare Git is not enough because current runtime requires Forge access/publication semantics.
2. **Gameplan startup enforces managed forge checkout.** `--repo-root` is ignored with `--gameplan` (`bin/main.ml:621-630`), so a disposable local checkout cannot be selected through current Studio launch arguments.
3. **Forge credentials and production endpoint are mandatory.** Resolved config requires a token (`lib/resolved_config.ml:62-69`) and GitHub API is fixed to `api.github.com` (`lib/github.ml:1178-1201`).
4. **Studio does not pass or select execution policy.** It launches only fixed headless flags (`studio/main.cjs:145-147`).
5. **Studio cannot gracefully control Onton.** It stores `controlPath` but never connects to it (`studio/main.cjs:141-152`, `166-178`).
6. **Studio cannot attach/reconcile after restart.** It fences a missing real process rather than using Onton authority/recovery (`studio/main.cjs:27-35`).
7. **Studio state projection is lossy.** Message regex cannot represent durable operation status, retries, CI, publication, or recovery tickets.
8. **No successful local acceptance fixture exists.** The existing coordinator fixture proves the distributed helper seam, not the `main.exe` path launched by Electron.

---

## 7. Ordered implementation milestones

### Milestone 0 — freeze contracts and policy

**Dependency:** none.  
**Acceptance:** written policy states local mode cannot read production credentials, cannot contact external forge endpoints, and cannot mark a task complete without real backend/process evidence.

### Milestone 1 — local Forge.S acceptance seam

**Dependency:** existing Forge.S and main capability construction.  
**Acceptance:** a disposable bare remote and local forge helper implement only the methods required by a one-patch Codex run; unsupported review/merge operations fail closed; production GitHub/SourceHut behavior is unchanged; no external network is reachable.

The implementation should be selected explicitly by a test/local profile, not by an empty token or a fake GitHub owner.

### Milestone 2 — successful CLI headless run

**Dependency:** Milestone 1.  
**Acceptance:** actual built `main.exe --headless --headless-transcript --no-refresh` runs one real Codex task in a disposable worktree, creates a commit, records transcript/activity, persists completion, and exits successfully. Capture bare-remote refs and all Onton data as evidence.

### Milestone 3 — typed headless read model

**Dependency:** Milestone 2.  
**Acceptance:** Studio receives canonical run/task/agent transitions and transcript chunks without regex classification; final unterminated JSONL records are flushed; persisted sequence/offset handling is deterministic.

### Milestone 4 — typed control client and cancellation

**Dependency:** authenticated control transport and Milestone 3.  
**Acceptance:** Electron discovers endpoint metadata, authenticates, sends a typed cancellation/guidance command, observes an acknowledged response, and only falls back to process-tree termination after timeout. Unix socket behavior and Windows token behavior remain covered.

### Milestone 5 — persistence/restart/recovery

**Dependency:** Milestones 2–4.  
**Acceptance:** stop during an active task, verify worktree/process cleanup and persisted terminal state; restart Studio and verify it reads Onton snapshot/events/transcripts; if attach is unsupported, it must explicitly fence the run and explain why rather than showing stale running state.

### Milestone 6 — opt-in Studio support gate

**Dependency:** all previous milestones and focused Playwright acceptance.  
**Acceptance:** real mode is enabled only with an explicit opt-in/profile; default Studio remains safe local/simulation mode; Electron security settings are unchanged; successful Codex, failure, cancellation, cleanup, and restart evidence are committed.

---

## 8. Verified facts versus assumptions

### Verified by source inspection

- `main.exe` owns the single-process orchestration path and can emit headless activity/transcript JSONL.
- `Forge.S`, `Worktree.S`, `Llm_backend`, `Session_driver`, coordinator/worker protocol, persistence, and control APIs already exist.
- Five backend selections are registered: Claude, Codex, OpenCode, Pi, Gemini.
- Gameplan execution ignores `--repo-root` and prepares an Onton-managed forge checkout.
- Resolved configuration requires forge credentials.
- GitHub API endpoint is hard-coded.
- Coordinator has an explicit forge-helper seam; main CLI does not.
- Studio is sandboxed and launches a fixed headless child with `shell:false`.
- Studio currently parses human headless messages heuristically and does not use its stored control endpoint.

### Assumptions requiring acceptance evidence

- A local Forge.S adapter can implement the exact minimal methods needed for one successful Codex patch without changing scheduler semantics.
- Codex is installed/configured in the acceptance environment and can run without production repository credentials.
- A local CI/review/merge observation model can satisfy the selected gameplan's required transitions without falsely claiming external evidence.
- The current headless JSONL output contains enough information to build a lossless Studio projection after final-line flushing and structured status additions.
- Graceful control cancellation can complete before the existing process-tree fallback under Windows timing constraints.

No assumption above should be promoted to a supported feature until the milestone acceptance evidence exists.

---

## 9. Concrete recommendation

Implement **one explicit local Forge.S/profile seam**, then reuse the existing `main.exe` runtime unchanged for the first real Codex Studio run. Do not launch a second coordinator architecture, do not fake GitHub over a network redirect, and do not make empty/fake credentials mean local mode.

The first supported Studio real-run path should be:

```
Studio main process
  -> explicit local-only Onton profile
  -> existing main.exe headless runtime
  -> existing Worktree_setup + Session_driver + Codex_backend
  -> disposable bare remote/local Forge.S evidence
  -> existing headless JSONL + persistence
  -> typed Studio read model/control client
```

Until that local Forge boundary is implemented and its acceptance passes, real Studio should remain an explicit guarded experiment, not a generally supported feature.

---

## 10. Additional repository-wide findings relevant to Studio support

These findings do not change the minimal Studio recommendation, but they affect what a Studio status/read model may safely claim.

### Backend contract drift

The common backend interface exposes only a name and streaming callback (`lib/llm_backend.mli:95-112`). Provider capabilities are implicit in backend implementations. The registry is the natural existing extension point (`lib/backend_registry.ml:28-48`, `60-73`), but a future capability record should be added only if Studio needs to display or enforce provider differences. It should cover safety/permission mode, resume syntax, effort support, model ladder, tool normalization, usage/cost, and terminal/error guarantees.

Provider-specific risks found by source inspection:

- Codex budget arithmetic is not explicitly overflow-bounded (`lib_core/codex_cost.ml:15-17`, `135-154`), budget-cap parsing accepts non-finite/huge floats (`lib/codex_backend.ml:34-44`), structured auth errors may not trigger retry (`:21-32`), and sandbox bypass is unconditional in the event/argv path (`lib_core/codex_event_parser.ml:122-129`).
- OpenCode lacks an explicit headless/noninteractive permission mode (`lib_core/opencode_event_parser.ml:10-22`), emits repeated session-init/turn-start events for steps (`:57-70`), and loses nested/non-stop failure information (`:97-114`).
- Pi silently ignores malformed input and maps every `agent_end` to successful final output (`lib_core/pi_event_parser.ml:28-31`, `73-78`); setup failures escape as exceptions (`lib/pi_backend.ml:59-89`), and session paths use manual slash concatenation (`pi_event_parser.ml:9-10`).
- Gemini drops useful model/stats metadata and emits empty final-result text (`lib_core/gemini_event_parser.ml:32-72`), permits empty tool-use records (`:56-65`), and lacks a common turn-start mapping.
- Claude has parser/session edge cases around duplicate terminal events, unknown stop reasons, tool-input deltas, and a public singular-event parser that can drop events (`lib_core/claude_event_parser.ml:181-207`, `236-245`, `271-300`).

These are not reasons to create Studio-specific backend implementations. They are reasons to avoid claiming authoritative success from raw provider messages. A shared backend conformance fixture should precede any UI that displays provider-level completion, cost, tool, or safety claims.

### Gameplan/schema validation drift

The runtime accepts format versions 2 and 3 (`lib_core/gameplan_parser.ml:708-715`) while the checked-in schema requires v3 and additional fields (`skills/write-gameplan/references/gameplan-schema.json:6-36`, `170`). Legacy parser paths silently drop malformed list entries, dependency edges, files, and precedents (`lib_core/gameplan_parser.ml:306-310`, `341-361`, `1037-1056`, `1110-1128`). OCaml path checks are weaker than the Python validator's absolute/parent-traversal checks (`lib_core/gameplan_parser.ml:1110-1128`; `skills/write-gameplan/scripts/validate.py:482-507`).

Studio should use the canonical parser or Onton-produced task projection, not reproduce this schema logic in JavaScript. Until that happens, malformed or legacy gameplans must be displayed as parse errors rather than silently rendered as an incomplete task graph.

### Scheduler/recovery observations

The scheduler has strong selected-base and admission gates (`lib_core/scheduler_decision.ml:32-53`, `69-159`) and bounded recovery (`lib_core/scheduler_recovery.ml:126-211`, `248-306`, `320-348`). Forge observations are ticket/context scoped and final forge mutation rechecks dependency admission (`lib_core/forge_observation.ml:12-44`, `138-200`; `lib/coordinator_forge.ml:704-710`).

There are nevertheless conditional checkpoint risks: an acknowledged resume path does not recheck generation in all branches (`lib/orchestrator.ml:794-799`, `836-867`), checkpointed normal busy state can lack a runnable outbox message (`lib/orchestrator.ml:1130-1143`; `lib_core/patch_agent.ml:1529-1543`), and `assigned_context` validation appears to have no direct caller (`lib/orchestrator.ml:594-665`). These are not Studio fixes. Studio must not invent recovery success; it should expose Onton's persisted recovery/attention state and fence unknown runs.

### CI/release qualification gaps

Release tags publish independently of CI and do not run the full acceptance path (`.github/workflows/release.yml:3-8`, `10-26`, `51-68`). The Windows release job lacks the packaged worker/coordinator/runtime smoke coverage present on Unix (`.github/workflows/release.yml:90-110` versus `117-150`). Publication acceptance is manual-only (`.github/workflows/publication-acceptance.yml:3-4`, `35-39`), and CI has no aggregate final gate (`.github/workflows/ci.yml:13-18`, `210-318`).

This is not a Studio implementation blocker, but a supported Windows Studio release should require a Windows package smoke test that launches the same main/coordinator/worker artifacts used by the Electron adapter.

### Platform/security notes

Native Windows process cleanup and Job Objects are the correct foundation (`lib/windows_process.ml`, `lib/process_tree.ml`). Remaining source-level risks include Windows argv quoting edge cases (`lib/windows_process.ml:31-40`), endpoint ACL assumptions (`lib/host.ml:90-100`), and inherited child environment persistence (`studio/main.cjs:145`). Studio persists stderr/transcripts into local user data (`studio/main.cjs:42-46`, `110-116`), so provider output must be treated as sensitive and future redaction/size/schema controls should precede broad sharing or export.
