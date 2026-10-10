# IH-ARCH-001 CI enforcement revision: fork candidate acquisition

Date: 2026-10-10. Scope: the owner explicitly authorized a separate CI repair for
Harness PR #84. This change retains IH-ARCH-001 ownership rules, the canonical
checker, and every migration exception. It proposes only an enforcement machinery
transition for owner review; it does not authorize its own activation on main.

## Problem and rationale

PR #84 comes from a fork. The trusted `pull_request_target` workflow checks out
the base revision successfully, but its second `actions/checkout@v4` of the fork
candidate is rejected before the architecture checker runs. Run 38030133340
therefore publishes failure from a skipped guard. Modifying the candidate's
workflow cannot fix the base-branch workflow that GitHub actually executes.

The replacement reads the public base repository's `refs/pull/<number>/head`
using a new bare Git object store, then requires `FETCH_HEAD^{commit}` to equal
the event's full head SHA. This ref represents both fork and same-repository PRs.
A moved ref, unavailable commit, invalid identity or failed fetch fails closed.
There is no fallback to a branch name, merge commit, different SHA or candidate
self-check. Acquisition currently supports public repositories on github.com;
private repositories fail closed rather than receiving credentials.

The base-branch helper enumerates the exact tree and reads raw blobs. It never
checks out candidate code, installs dependencies, follows submodules, runs hooks
or applies filters. It does not use archives: candidate `.gitattributes`
`export-ignore` and `export-subst` cannot hide or rewrite inspected files. Child
Git processes have a minimal environment with no token or inherited Git config,
credential helpers, object alternates or replacement objects. HTTPS is the only
allowed transport. The base checkout uses `persist-credentials: false`; no cache
or artifact is restored or published in this path.

Every candidate entry must be a regular blob. Symlinks, gitlinks, non-UTF-8 names,
control characters, traversal, backslashes, `.git` components and duplicate case
variants are rejected. The destination must be new, outside the trusted checkout;
exclusive writes cannot overwrite it. Limits are 20,000 files, 64 MiB per blob and
256 MiB total materialized data, with bounded Git command output/time and a job
timeout. Partial materialization and the temporary object store are removed on
failure. These limits bound inspection; a very large fetch can still exhaust the
ephemeral runner and will fail the check rather than bypass it.

Only the base checker and base policy inspect the candidate data. Trusted
regressions also run from the base checkout. The inspection job has only
`contents: read`. A separate job with only `statuses: write`, no checkout and no
candidate data publishes `Architecture contract` against the event's head SHA.
Only an entirely successful inspection job yields success; failure, cancellation
or skipped acquisition/checking cannot produce success. If a workflow is
cancelled before status publication, it cannot publish a successful result.

## Migration and acceptance

The workflow, acquisition helper, acquisition tests and review record are
hash-protected in policy and owned by the architecture owner. The existing
checker, exception maps, frozen prefixes and contract identity are unchanged.

Before activation, run `pnpm test:architecture-contract`, `pnpm test:architecture`
and the acquisition regressions. Acceptance covers exact SHA/ref selection,
fork/same-repository inputs, fetch failure and moved heads, malicious candidate
checker/policy/scripts, archive attributes, unsafe paths/modes, limits, cleanup
and independent status publication. Additionally acquire actual #84 and a
same-repository PR through GitHub's canonical refs and inspect both with trusted
code only. Record the acquired SHAs and checker outcomes in the repair PR.

The old base policy intentionally rejects this PR's changed machinery/hashes.
That rejection is evidence that features still cannot self-authorize machinery
changes. It must not be bypassed inside this workflow or turned green using the
candidate policy. Activation requires the owner's deliberate reviewed policy
transition under the existing repository administration process. Do not merge
automatically or modify main directly. After the owner merges the revision,
first rebase or merge latest main into #84: its candidate must carry the newly
protected workflow/helper/test/policy bytes, and the old ledger cannot silently
grandfather them. Then trigger a fresh `pull_request_target` event (the head
update does so). Re-running an old workflow run can retain the old workflow revision and
does not demonstrate activation. Other existing required checks remain required.

## Local evidence (2026-10-10, macOS arm64)

- `pnpm test:architecture-contract`: checker passes and 19/19 tests pass.
- `pnpm test:architecture`: checker passes and 32/32 tests pass after installing
  the committed lockfile with dependency lifecycle scripts disabled.
- The repair tree checked against main's old policy fails on the changed
  governance ledger, CODEOWNERS and workflow, as required for an owner transition.
- Actual fork #84, SHA `2e09b3c88af3d778fe591ea8ba588e8c68517669`: 682 raw
  files, 125,017,757 bytes; current main's trusted checker/old policy passes.
- Actual same-repository #88, SHA `0e1d6b1c20e521b55856ea5b9c9d473fec27ad93`:
  684 raw files, 125,014,653 bytes; current main's trusted checker/old policy passes.
- Both unchanged PR trees fail against the proposed protected machinery hashes,
  proving they must synchronize main after activation. No candidate code or
  candidate tests were executed in either acquisition/inspection.
- Initial 32 MiB blob bounds rejected the existing 48,528,022-byte OCCT source
  archive in both PRs and removed partial data; the final 64 MiB bound admits the
  existing tree while total data remains limited to 256 MiB.

This is local acquisition and static policy evidence, not a claim that the new
`pull_request_target` workflow has already run on GitHub or that native industrial
qualification has been repeated. Activation still follows the migration above.

References: [GitHub pull_request_target security boundary](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target),
[Git tree enumeration](https://git-scm.com/docs/git-ls-tree),
[Git fetch](https://git-scm.com/docs/git-fetch).
