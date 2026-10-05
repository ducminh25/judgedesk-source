# Antigravity remediation handoff — WP0.4 LOG-0066-F1

Remediate exactly WP0.4 in the saved dirty checkout D:/Minh/Code/judgedesk. Preserve the existing dirty worktree, accepted WP0.3 baseline, prior logs, and every historical artifact. Do not reset, stash, clean, commit, push, bump versions, close G0, begin WP0.5, or self-accept.

## Finding to fix

In native-executor/src/main.rs, serve_requests currently handles serde_json::from_slice failure by sending SECURE_RUNNER_PROTOCOL_ERROR with an empty ID and continuing the request loop. Independent evidence is in artifacts/wp0.4/independent-review-log0066-codex-20260927/malformed-request-probe.json:

- The frozen staged Windows executor at src-tauri/binaries/judgedesk-executor-x86_64-pc-windows-msvc.exe was ready with all required capabilities.
- A framed invalid JSON payload containing { returned an error.
- The same executor generation then served another health request with ready=true and exited cleanly only after a later normal shutdown.

Treat malformed JSON and unknown request variants as terminal protocol failures. Stop request admission, enter the existing drain path, keep the generation guard until every accepted and active native process has drained, then exit with a failure result. Do not continue serving health/run/cancel requests after the terminal protocol failure. Preserve valid framed-v1 compatibility for the Node rollback client.

## Required regression evidence

Add focused integration coverage against the exact packaged candidate selected by the frozen source identity. Cover malformed JSON and an unknown request type. Prove the process does not serve a subsequent request, active and reserved work drains before the generation guard is released, and a replacement executor can start only after the prior process exits. Keep debug target fallback and JUDGEDESK_EXECUTOR_PATH override from counting as packaged selection evidence.

The test must own its temporary roots, capture child exit and process/port state, and verify cleanup. Do not use test-only simulated ExecutorRunResult or mock responses as proof of native drain.

Correct the LOG-0065 executable-provenance source list: native-executor/src/platform/unsupported.rs does not exist in this checkout. Keep the staged executable, target/release output, build recipe/toolchain, actual source closure, source freeze, and hashes aligned.

## Submission requirements

Run focused RED/GREEN for the fix. Then use the efficient-execution protocol for one frozen candidate completion run and relevant locked Rust, security, and platform checks. Preserve the existing 1.5.1 eight-file version lockstep. Revalidate all 30 accepted WP0.3 baseline hashes; freeze every actual production, test, build, packaging, and executable input with SHA-256, byte size, and UTC mtime; verify the executable actually launched and its build provenance. Audit both C:/Users/mon/AppData/Local/ThemisV2 and C:/Users/mon/AppData/Local/JudgeDesk/JudgeDeskExecutor before and after, account for every delta, and record delayed process/port/temp cleanup.

Keep macOS evidence explicitly separate from Windows. Arrange or report the actual macOS platform/runtime evidence required by the package; do not claim Windows proves macOS behavior.

Update STATUS, the WP0.4 report, ADR 0001, and append-only WORKLOG with synchronized source identity and a new submitted-for-verification handoff. Preserve LOG-0066 evidence. Stop all edits at VERIFYING and leave acceptance to a fresh Codex reviewer.
