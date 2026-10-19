# Remote integration merge audit — 2026-10-19

## Merged prerequisites

- Domain Packs #48: `020866410e75e8eeb9183233eea9b2836e1bcba4`, restores local PCB/FreeCAD verifier inputs while retaining strict remote checks.
- Harness #220: `e6c7c16e7fc2b07de41691ebe988df18a39fc447`, desktop fixes and QA. Required PR checks passed; the separate full workflow's macOS Docker prerequisite remains tracked in #219.
- Harness #189: `18cd99fde5ee104fa25df9b203f6a967f90cb1c2`, account isolation and durable task finalization. The shared-session regression uses `createProject`, preserving the first-mutation/zero-send assertion across both client generations.
- Harness #222: `26ded5be60a0144deab0288e8fb86ceaa84bfe32`, propagates the previously accepted #221 CAD and automatic sandbox release into #200.
- Domain Packs #49: `ccc1ad4b655eac0d3946bf49ea645299bcd4ef2d`. Source checks and architecture checks passed on immutable source commit `df0ac91ee5619952be9c511b73f715a11c8dd01b`, which Harness consumes.

## Repairs in the final consumer candidate

The merged Pack release had listed the remote Linux FreeCAD AppImage as a desktop managed runtime asset. Harness correctly rejected that incomplete, unsupported host declaration with `Invalid managed runtime declaration`. Owner PR #49 removes that host entry while preserving the Linux image recipe/profile and its existing pins. Package 0.5.5 / FreeCAD 1.1.4-pack.10 include refreshed resource/content hashes and host/remote boundary regressions. Root, CLI, Desktop and the domain-skills peer declaration now consume that published identity.

The four #200/main conflicts were resolved in `e0b55808a56917386f9975cb3bace646fd790680`: keep both Settings-popover and modal UI regressions, preserve the remote layout/tool badges and translations, and retain token subject checks before and after token acquisition. All four resulting blob identities were compared with the reviewed local integration.

The newly runnable Windows Desktop job `117905437821` then failed its existing focus-indicator assertion. Settings dismissal queued a focus restore for the next animation frame; that callback could steal focus from the next input. Explicit dismissal now restores focus immediately, while outside-pointer dismissal continues to preserve the receiving control. The real renderer selftest additionally closes Settings, focuses another control immediately, and verifies that subsequent animation frames do not move focus away.

Native thinking tests already await session shutdown; their temporary-directory cleanup now retries transient Windows handle contention for a bounded interval. Persistent cleanup failure still fails the test.

## Validation and limits

- Previous integrated account/results/Gateway/session/automatic-release regressions: 73 passed; native thinking: 4 passed; architecture: 48 passed; Pack consumer/type checks: 17 passed; Desktop build passed.
- Owner #49: 114 JavaScript tests passed, 1 environment-dependent skip; 11 architecture tests passed; content lock passed; real stdio MCP discovery/server-info passed with 25 tools. Remote source and architecture CI passed before merge.
- Fresh frozen-lockfile installation fetched the published Pack commit successfully. The local Portable rerun completed 757 tests: 748 passed, 8 failed, 1 skipped. Seven failures are attempts by test fixtures to write the protected user profile; one cannot create a DMG (`hdiutil: device not configured`). These are not counted as passes. The packaged CLI/SDK checks that previously failed on the unpublished Pack now pass.
- Local Electron UI startup remains unavailable in this execution environment (`SIGABRT`). Actual Windows/macOS CI renderer jobs must validate the final focus fix; no local UI pass is claimed.
- Final exact-head CI is required before merging #200. No workflow gate, architecture exception, native qualification or approval requirement was weakened. This integration does not claim new native platform qualification or a production deployment.

The earlier automatic approval-service outage prevented publication; normal Git/PR operations subsequently recovered. The repaired consumer pin points to a real published commit, not a local-only candidate. Real CAD acceptance remains in `doc/evidence/remote-cad-20261019`; it exercised build and artifact/viewer flow, not every discovered tool.
