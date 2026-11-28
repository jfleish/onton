# Onton Studio v0.1.0 internal beta report

Date: 2026-11-28
Branch: `studio-development`
Evaluation type: local packaged Windows x64 beta run; no public services or external Git operations

## Executive assessment

**NO-GO for a real multi-step dependent software project.** Studio is usable for setup, local Codex execution, independent tasks, commit/transcript capture, and basic failure visibility. It is not yet reliable enough for a realistic dependency chain: a dependent task was scheduled only after its prerequisites completed, but its worktree was based on the unchanged base branch and did not contain the prerequisite commits. The dependent task correctly refused to fabricate a result, but the run could not complete.

The OCaml engine remained the execution authority. No orchestration logic was duplicated in Electron. One critical Electron correctness fix was made for non-`main` repositories; the dependency/worktree and restart issues remain unresolved because fixing them requires coordinated OCaml scheduler/recovery work rather than a safe UI-only patch.

## Real project and isolation

- Test project: disposable clone of the actual Onton OCaml/Electron application.
- Clone: `phase6c-results/internal-beta/onton-app`
- Baseline: commit `2ec81b6f`, existing source, Dune tests, Studio code, and full Git history.
- Remote: local bare repository at `phase6c-results/internal-beta/remote.git`; `origin` did not point to GitHub.
- No unrelated user repository was modified.
- Studio configuration: `backend=codex`, `forge=local`, `maxConcurrency=2`.
- UI confirmed: `External forge operations disabled`.

## Gameplan and execution evidence

The plan contained four meaningful tasks:

1. Add a pure `Text_metrics` OCaml utility.
2. Add duplicate-ID and dependency-cycle parser regression tests.
3. Add unit tests for `Text_metrics`, dependent on tasks 1 and 2.
4. Add a small CLI smoke tool, dependent on task 3.

Packaged portable Studio run:

- Run ID: `real-1795841131478`
- Project branch: `studio-development`
- Tasks 1 and 2 ran concurrently at the configured concurrency of two.
- Task 3 remained queued until both prerequisites completed, then started.
- Task 4 remained queued behind task 3.
- Task 1 committed `545873540a30188ce0e6e0cb9a40eb8b5731d868`.
- Task 2 committed `5d78b5ab6fa438843d1289f3d7c01ba6428e570b`.
- Task 3 detected that those commits were not in its base and wrote a `WONTDO.md` blocker instead of producing an invalid commit.
- Task 3 transcript had 16 entries; task 1 had 18; task 2 had 22.
- Artifacts included task 1's two OCaml files, task 2's parser test, and task 3's blocker report.
- Worktrees were materialized at `C:\Users\josep\worktrees\onton-internal-beta\patch-{1,2,3}`.

This verifies concurrency and dependency gating, but also exposes the central real-project failure: dependency ordering does not make completed dependency commits visible in the dependent worktree.

## Independent code review and tests

The two successful agent commits were independently cherry-picked into a separate review clone outside the target repository:

- `dune build @check`: PASS.
- `dune runtest test/test_gameplan_parser_properties.exe`: PASS, 27 tests.
- Manual review found the `Text_metrics` implementation total and pure, with documented empty/whitespace/trailing-newline behavior.
- Manual review found the parser tests deterministic and asserting duplicate IDs and cycle rejection.

A full `dune runtest` was attempted. It did not complete successfully on this Windows development environment. The output included unrelated/pre-existing environment-sensitive failures and timeout/resource issues, including gameplan publication timeout, coordinator stream backpressure, missing fixture data, Windows cleanup/`rm` incompatibilities, worker protocol cleanup, and feature-branch Git fixture failures. Therefore full-suite integration is **not claimed PASS**.

## Persistence, recovery, and failure reporting

After the run reached the dependency blocker, Studio was stopped and restarted using the same user-data directory. Commits, task states, artifacts, transcripts, and the `WONTDO.md` explanation were still visible after restart. However, Studio marked the run failed with:

`fenceReason: Studio restarted without an attachable Onton process`

Thus durable evidence survived, but run-state recovery did not preserve the prior terminal/blocker state as a recoverable completed run.

## Desktop experience

Verified through the packaged renderer/CDP surface:

- Project selection and Git-root validation worked.
- Non-`main` branch was detected after the fix below.
- Gameplan validation returned all four tasks.
- Backend/forge/concurrency configuration was visible and saved.
- Dashboard showed live task states, completion percentage, agents, transcripts, commits, artifacts, and `Needs attention` failure state.
- Error reporting was actionable: task 3 exposed the exact missing dependency commits and wrote a blocker report.
- The advertised `Dependency flow` is a textual task list; no rendered graph nodes were present (`graphNodes=0` in the inspected DOM). This is usable for four tasks but weak for a nontrivial DAG.
- Structured format-version 2/3 plans remain executable/importable but are intentionally not editable in the Studio builder; this limits editing existing real-world plans.

## Five highest-impact problems

| # | Category | Problem | Status |
|---|---|---|---|
| 1 | Correctness bug | Studio defaulted every newly opened repository to `main`. The real clone used `studio-development`, so the first run failed before scheduling. | **Fixed** in `studio/main.cjs` by restoring persisted config or detecting the current Git branch. Rebuilt package and verified `mainBranch=studio-development`. |
| 2 | Correctness/reliability | Dependent tasks are scheduled after prerequisites but their worktrees are based on the unchanged base branch. Task 3 could not see task 1's module or task 2's tests and blocked. | **Unresolved.** Requires OCaml dependency materialization/integration semantics; not safe to patch as an Electron workaround. |
| 3 | Reliability | Restarting after the Onton process ended fenced the run as failed even though durable commits, transcripts, artifacts, and blocker state were recoverable. | **Unresolved.** Recovery should distinguish an already terminal persisted run from an unattachable active process. |
| 4 | Usability limitation | The dependency “graph” is only a textual list, with no visual DAG or direct dependency-path explanation. | **Unresolved.** Makes larger real plans difficult to reason about. |
| 5 | Usability limitation | Existing structured format-version 2/3 plans cannot be edited in the builder, only imported/executed. | **Unresolved.** Real repositories using current structured plans require an external editor. |

Additional validation risk: the full Windows `dune runtest` suite did not complete cleanly in this environment, so Studio should not claim full application-test integration from agent commits alone.

## Security and external operations

- No external Git operation was observed or enabled.
- The disposable clone's `origin` was a local filesystem bare repository.
- Studio displayed local forge mode and external forge operations disabled.
- No new security vulnerability was found during this evaluation.
- The branch-detection fix does not broaden process, filesystem, or network authority.

## Required follow-up before real-project beta

1. Define and test how dependency commits become the base of dependent worktrees while preserving OCaml orchestration authority.
2. Add recovery tests for restart after terminal, blocked, and process-lost runs; preserve terminal state when durable evidence is complete.
3. Decide whether a visual DAG is required for beta-scale plans.
4. Provide an editing path for structured gameplans or clearly mark them read-only in setup.
5. Establish a reproducible Windows full-suite test environment and remove/guard Unix-only cleanup assumptions.

No release was published. The disposable test repository and generated run evidence remain under `phase6c-results/internal-beta/` and are not product changes.
