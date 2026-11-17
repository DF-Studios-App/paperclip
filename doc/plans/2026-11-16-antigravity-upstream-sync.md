# Antigravity support and upstream sync for the fork — 2026-11-16

Owner: fork maintainer (Daniel), executed from worktree
`antigravity-fork-support-cf9f8b`, branch `claude/antigravity-fork-support-cf9f8b`.
Status: upstream merge committed on the sync branch; PR open for review. The migration guard still reports 8 `unknown` migrations (see the PR).

## Questions and answers

1. **Does upstream `main` (`paperclipai/paperclip`, `upstream/master`) already have native Antigravity support?**
   Partially, and it is not yet qualified.
   - Native Paperclip Runner integration exists in `packages/paperclip-runner`:
     - `antigravity-distributions.json` pins ACP server **1.4.3** with verified
       darwin-arm64 closure; other platforms are inventory-only.
     - `acpx-profiles.json` has an `antigravity` profile with
       `qualificationStatus: "pending"`.
     - Scripts for provisioning, probing metadata and patching the runtime.
   - Plan docs: `doc/plans/2026-10-28-antigravity-integration.md`,
     `2026-10-29-antigravity-candidate-identity-refresh.md`,
     `2026-10-29-antigravity-journey-to-eval.md`.
   - Gemini 4 Argon (`gemini-4-argon`) is in the OpenCode catalog. Gemini CLI
     does not register it yet (`doc/adapter-model-audit-2026-10-23.md`).
   - Upstream has **no** `agy-local` adapter. That adapter exists only in this fork.

2. **Is "Gemini 4 Hydrogen" released?** No, not officially.
   - Public reporting (through 2026-11-08) calls "Hydrogen" an unconfirmed leak
     codename for a Flash-tier model. Official model in the Gemini API: **Gemini 4 Argon**.
   - So there is no model ID to add for Hydrogen. Adding a placeholder ID would
     be guessing.
   - The fork already targets Argon: `gemini-4-argon-high|medium|low` are on
     `master` (`packages/adapters/agy-local/src/index.ts`). The branch
     `feat/agy-local-argon-4` duplicates that work and should be retired.

3. **State of the fork.** `master` is 59 commits ahead of `upstream/master` and
   2644 commits behind it. The merge base is `25f2d052`. A dry-run merge reports
   34 conflicted paths.

## Fork-only work that must survive the merge

- `agy-local` adapter: `packages/adapters/agy-local/`, its UI, tests, Git
  exclusion/read-only handling, runtime MCP config security, cumulative usage,
  remote auth, `gemini-4-argon` IDs.
- Company-shared AGY accounts with quota failover; quota view per account
  (`packages/shared/src/agy-accounts.ts`, `server/src/routes/`, `ui/.../agy-accounts`).
- Root CEO leader board access (`feat(agents): give the root CEO leader agent board-equivalent access`).
- Routine execution-slot claim fix (`fix(heartbeat): defer a claim...`).
- Fork CI reductions and Greptile removal (see `doc/FORK-OPERATIONS.md`). Disabled workflows stay disabled.
- Windows LF checkout and Windows Runner build fixes.
- GitHub shell identity and repo URL matching; Claude subscription token renewal;
  Windows local login credential reading.
- Claude Sonnet 5.5 / Haiku 5.5 model entries and effort levels (upstream may
  carry equivalents; reconcile instead of duplicating).
- Manager authz to cancel and wake reports' runs.

## Conflict policy

- **Take upstream** for the Native Runner, ACPX profiles, Antigravity distribution
  pins, and generic infrastructure with no fork intent.
- **Keep fork** for everything in the list above and for `AGENTS.md` section 0
  (fork destinations) and fork CI state.
- **Reconcile** where both sides changed the same behavior (Claude model lists,
  `claude-local` index, heartbeat queue, authz helpers): keep upstream structure
  and re-apply the fork's intent. Do not keep both copies.
- Never add a model ID that is not officially published (no Hydrogen ID).
- Lockfile: resolve by regenerating with `pnpm install`, not by hand-merging.
  Follow the repository lockfile policy.

## Steps

1. Read the scoped rules before editing matching files:
   `rules/heartbeat-execution-boundaries.mdc` (heartbeat queue/services),
   `rules/chat-channel-platform-boundaries.mdc` (chat channels),
   plus any `alwaysApply` rules.
2. `git merge --no-commit --no-ff upstream/master` on this branch.
3. Resolve the 34 conflicted paths per the policy above, grouped by area:
   CI/docs/rules, claude-local, paperclip-runner, server routes/services, tests.
4. `pnpm install` to regenerate the lockfile if the merge changed manifests.
5. Verify (see below). Leave the merge uncommitted.
6. Commit, push to `origin`, and open a PR into `DF-Studios-App/paperclip` only
   after the user approves.

## Verification

- `pnpm -r typecheck`
- Targeted tests: `pnpm vitest run` on `agy-local-adapter`, `agy-local-runtime-config`,
  `agy-accounts`, heartbeat queue/slot tests, authz tests, adapter display registry.
- `pnpm check:token-gates` if any `ui/` file changed.
- `node scripts/check-maps.mjs` if the map docs changed.
- Full `pnpm test:run` and `pnpm build` before a PR-ready hand-off.
- Anything not run is reported as not run.

## Risks

- 2644 upstream commits: some conflicts may hide behavior changes that the fork
  depends on. Targeted tests reduce this risk but do not remove it.
- Upstream Native Runner Antigravity is pending qualification. Shipping it in
  the fork does not make it qualified.
- The existing branch `sync/upstream-master` (worktree `C:/DEV/paperclip-worktrees/upstream-sync`)
  holds 52 fork commits and is also 2644 behind upstream. It was not touched. Decide
  its fate with the user.
- Antigravity CLI and ACP versions are separate release lines. Do not conflate
  `agy` CLI versions with ACP server 1.4.3.

## Open decisions for the user

- Approve the commit and PR after verification.
- Retire `feat/agy-local-argon-4` (its IDs are already on master) and decide the
  fate of `sync/upstream-master`.
- Confirm that Argon is the target. Hydrogen only becomes a target when Google
  publishes an official model ID.
