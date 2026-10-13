# Step 3B — owned local compatibility probes

Scope: local C/C++/Python quick probes only. No OSD, dependency, compiler fallback,
manual verification requirement, snapshot/content certificate or Pascal/Scratch
isolation claim. Step3A admission is strict-only; compatibility is not integrity.

CLAIM: readiness requires the owned compiler/link sample and the produced program
to run successfully as both submission and native checker; Python requires both
submission-runtime and checker-runtime. Cancellation must not publish compatible
or delete a workspace while its accepted native run might still exist.
WHY: compile success alone does not prove the generated image can run under the
actual role boundary, and early abort rejection can race native process cleanup.

## Proposal for independent review

Compile a small owned C or C++ I/O sample using the existing strict compiler spec
and resource bounds, then run its workspace executable with the existing submission
and native-checker spec builders. Python retains its two isolated runtime roles.
Use the native client's existing synchronous beforeSubmit callback to reject an
already aborted signal immediately before the ordered pipe write; register one
abort listener and cancel only the currently submitted run. Await its terminal
run response and any cancellation acknowledgement before advancing stages or
disposing the workspace; a signal aborted after runner completion still yields
incompatible admission. A matching run_result with reason internal_error is NOT
drain evidence: Windows can return it when its Job Object is not empty. If an
accepted run leaves neither a non-internal-error terminal result nor a positive
cancellation drain acknowledgement, retain its owned workspace and operation,
publish incompatible admission, and reject the lifecycle promise with a typed
cleanup-unconfirmed error. Recovery remains step6 work, but truthful shutdown
failure and prevention of replacement probes are part of this step.

Keep admission cache and operation ownership separate. Cache invalidation revokes
publication without forgetting the in-flight operation. All callers for the same
canonical executable/kind join its operation-owned controller/promise; a joining
live caller's abort cancels that shared operation. Shutdown cancels and awaits ALL
owned operations, including those initially started by a resolver without a caller
signal. An uncertain operation remains retained and prevents another probe even
after rescan or metadata changes. Confirmed completion may release operation
ownership; an invalidated result cannot repopulate admission.

## Contract

- Use existing OS sandbox APIs through the executor, no sandbox emulation.
- No resource-only identity/spec and no alternate compiler on failure.
- A successful compiler must produce a regular workspace executable; failure of
  either runtime role makes the whole quick probe incompatible.
- Bound all phases, outputs and diagnostic text; avoid spawning duplicate probes.
- Abort before submission writes no run; abort during startup cannot miss the
  beforeSubmit check; abort after submission requests cancellation once.
- No Promise.race that resolves the probe before the accepted run drains. Remove
  listeners on every terminal path. Only non-internal-error terminal results or
  positive matching cancellation acknowledgements prove drain; uncertain cleanup
  stays fail-closed, preserves workspace/operation, and fails discovery shutdown.
- Cache clear cannot start a concurrent replacement. Operation-owned cancellation
  works for a resolver-started probe later joined by discovery. After cancellation,
  even a runner that returns normally cannot publish compatible admission.
- Unit tests use real workspace/spec builders and a fake native client boundary
  with deterministic deferred startup/run/cancel results. They do not count as
  kernel sandbox proof. Windows host positive probes need real compiler/runtime;
  macOS runtime is NOT_RUN without a real host. Negative kernel isolation belongs
  to step4; do not label this compatibility check a security certificate.

## First review reconciliation

All four findings are valid + actionable, verified against the caller/Windows
source. User skipped cross-model review. Changes above address: internal_error
is not proof of an empty Job Object; cleanup uncertainty must escape the fulfilled
snapshot catch; a joining discovery signal must reach resolver-started work; and
cache clear must revoke admission without releasing in-flight deduplication.
Native protocol/Windows source are not modified here; unknown cleanup is retained
conservatively rather than claiming stronger evidence from the existing wire.

## Code review reconciliation and verification checkpoint — 2026-10-13

Second reviewer finding valid + actionable: missing/unknown result reason passed
the non-internal-error check. Canonical Node IPC validation now rejects such run
and interactive child results; the probe also requires a recognized reason for
drain evidence. Positive cancel acknowledgement remains an independent proof.
Third bounded review found no high-confidence actionable issue. User skipped
cross-model at each cycle; no external CLI. Stop after these three cycles.

Focused behavioral RED/GREEN: original ownership7/7; registry/run/runtime22/22;
IPC client30/30. Missing/empty/oversize/directory compiler output denied before
runtime; compatible cache revoked when closing. Native in-place GCC/Python gate
currently fails (Windows DLL_NOT_FOUND/ACCESS_DENIED), so compiler/runtime host
acceptance remains open. Controlled copies test the pipeline only, not original
paths. No weakening isolation, permissions, versions, native identity or tests.

Host fixture correction: release executor ignores JUDGEDESK_EXECUTOR_TEST_ROOT.
First copy-positive log is excluded from isolated-root acceptance. The opt-in
Windows gate now sets process-scoped LOCALAPPDATA/APPDATA, runs an owned copy of
the executor and checks canonical health-root containment before probe/copy.
Copy staging reuses bounded regular-directory primitives. Two gate-created
cache directories from the first run were moved to an owned recovery directory,
not erased; installed packages and unrelated caches were left intact.

## Final code gate — 2026-10-13

Sequential `artifacts/local-probe-3b-check-full-final-20261013.log` exited0:
fast PASS, Rust9/9, server912 tests /902 pass /0 fail /10 existing conditional
skips, live corpus25, checker parity67 at all four tiers, version1.5.5.
Post-gate all30 frozen inputs, staged executable SHA-256 and952320-byte size
matched `executor-freeze-2026-10-12.json`; diff whitespace check passed.
This closes deterministic code/regression verification, not universal local
compatibility: corrected copy-controlled native gate4/4, original-path gate0/4.
Reuse the existing snapshot/certified-local path when designing the next change;
probe and actual judging must use the same selected deployment. No native source
or wire change, new dependency/skip, commit/push or version bump in this batch.
