# WP0.2 independent Round 4 review

Reviewer: Codex. Decision timestamp: 2026-09-20T17:58:00+07:00. Source: Windows HEAD `d80f997cdafaf85883e7602de26c32dd355795a1` plus current shared dirty checkout. Submission: LOG-0020, the latest entry before this review. Decision: **IN_PROGRESS**; WP0.3 remains **NOT_READY**. No implementation remediation or version changes were made by this review.

## Findings requiring remediation

1. **High — settled background failures are lost.** `server/test-fixtures/api-contracts/backend-adapter.ts:82-87` consumes rejection and removes the operation immediately; `close()` at lines 149-160 only examines still-active promises. Independent probe tracked `Promise.reject(new Error('settled-before-close'))`, waited 25 ms, then closed: output `CLOSE_SUCCEEDED`, exit 0. The submitted test closes immediately and misses the deletion microtask. Retain failures until lifecycle teardown reports them, including already-settled failures; stop admission before draining and cover work admitted during close.
2. **High — Rust termination reports success without observed exit.** `backend-adapter.ts:321-360` swallows kill errors, ignores taskkill status and resolves on a safety timer. Independent method-level fault probe supplied an EventEmitter child with null exitCode and a throwing kill method: `TERMINATE_RESOLVED_WITHOUT_EXIT 2005`, exit 0. This probe proves control-flow failure, not a real surviving OS child. The submitted `.cmd` readiness test asserts timeout text only, with no observed PID exit or port rebind. Require real child/process-tree exit and port release before successful close; preserve kill errors and reject a deadline without exit.
3. **High — setup rollback and aggregate runner deletion remain fail-open.** `test-environment.ts:150-175` swallows rollback deletion errors; `scripts/run-all-tests.js:126-130` has an empty catch around root deletion. Independent setup probe injected `SENTINEL_SEED_FAILURE` plus `SENTINEL_ROLLBACK_DELETE_FAILURE`: only the seed error surfaced and `LEAKED_ROOT ... true`; reviewer recovery removed that exact owned root. Aggregate setup and rollback failures, report retained paths, and make runner deletion failure nonzero. The focused suite's own before/after at `server/api-contracts.test.ts:50-63` is still sequential rather than guarded/aggregating.
4. **High — canonical background ownership remains incomplete.** Preference route `server/routes/toolchain-routes.ts:641` calls rescan without the tracker. Live isolated PUT `/api/toolchains/profiles/cpp-legacy-v1/preference` returned `STATUS 200 TRACKED 0`. Discovery environment cleanup now drains this work, so this probe does not demonstrate a current host write leak; it disproves complete adapter ownership. `discovery.ts:1336-1345` also uses `require()` in ESM inside a swallowed catch, ignores kill status and clears child tracking; `drainToolchainDiscovery()` uses allSettled without propagating failures. The scripts delete contract context before adapter drain. Unify ownership/order and test rejection, late admission and child exit rather than relying on normal-path hashes.
5. **High — provenance is still unproven.** `artifacts/wp0.2/discovery-v2-provenance-audit.json` retracts trusted regeneration but retains an unsupported timestamp-only semantic comparison and ends in `VERIFIED_SECURE_AND_DRAINED`. Baseline content is unavailable; path-existence booleans do not establish equality or trusted provenance. Preserve the retraction, distinguish inference from proven history, then supply known-good restoration or controlled canonical regeneration with retained inputs and semantic evidence. Do not fabricate baseline content.
6. **Required evidence correction — zero-leftover claim is false.** Final audit found `C:\Users\mon\AppData\Local\Temp\jd_contract_env_HEgO55` (created 16:21:19) and `jd_contract_env_LwUWue` (16:22:59), both predating this review. Their ownership/cause was not established, so they were preserved. Investigate and recover only after proving ownership. No current-review process/listener or test-owned contract root remained.

## Confirmed improvements

- Production `server.rs` now uses native defaults; `autobins=false`, a non-default `test-server` feature and required-features exclude the test binary from default builds. The focused suite rebuilt the release server, checked absent test symbols and confirmed building test-server without its feature fails.
- Discovery pins its destination path at start and environment cleanup drains before restoring environment; submitted nested-surrogate regression passes.
- Scripts now guard environment/adapter construction and use compositional teardown that attempts all listed stages. The remaining failures above are in internal rollback, ownership and child termination.
- Install is injected/stubbed for Node contract tests. Inventory and ordinary contract/gate results reproduce.

## Verification run in this review

| Command/probe | Root | Expected / actual | Exit |
|---|---|---|---:|
| `node scripts/check-api-contracts.js`, twice | N/A | PASS, 29 manifest / 33 callers / 29 Node / 29 Rust both times | 0 / 0 |
| `npx tsx scripts/check-contract-parity.ts --adapter=node` | owned jd_contract_env_yZl8QU | PASS 30/30 | 0 |
| `npx tsx --test server/api-contracts.test.ts` | owned jd_contract_env_ZEfKTA and nested roots | PASS 26/26 | 0 |
| Rust parity `--adapter=rust` | owned jd_contract_env_ygOpXA | Strict mismatch signal, 9/30, 21 gaps; not full Rust parity | 1 |
| Rust parity `--adapter=rust --report-only` | owned jd_contract_env_48kxRr | Report command succeeds, same 21 gaps | 0 |
| settled-rejection probe | no filesystem/server needed | FAIL acceptance: close succeeds | 0 |
| terminate-child fault probe | synthetic child; no OS process | FAIL acceptance: resolves without exit | 0 |
| preference route tracking probe | owned contract environment | FAIL acceptance: HTTP 200, zero tracked operations; environment drained/removed | 0 |
| setup/rollback fault probe | owned jd_contract_env_kkLvjo | FAIL acceptance: rollback error hidden, root retained; reviewer recovery removed it | 0 |
| `cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml -- --test-threads=1` | existing Rust test-managed roots | PASS 38/38 | 0 |
| `cargo test --locked --manifest-path native-executor/Cargo.toml -- --test-threads=1` | existing native test roots | PASS 54/54 | 0 |
| `npm run check:fast` | N/A | PASS | 0 |
| `npm run check:full` (includes test:server and version gate) | automatic owned server/contract roots | PASS 558 passed / 0 failed / 10 skipped, 39 suites | 0 |
| `npm run release:check-version` | N/A | All eight version files remain 1.5.0 | 0 |

The earlier standalone test:server session lost its final retrievable output during session interruption; it is not claimed as a separately confirmed pass. Full gate reran it successfully with retained log. Full gate log SHA-256: `0878088A5783C0269728A6EB3A7CE7AF5A0AB86410719A961507C1525F7B1CDA`.

Both inventory runs: inventory SHA-256 `F76EE7266FCBDE85CCD452127B888BAF247516BFE5EB72611CC85BC78508806C`; matrix SHA-256 `96B7786278759568A3E88F5972169A1EE3291BFE920711C9CEDE8DE51E7EA026`.

Normal suites emitted no observed post-completion error. During execution, prewarm logged `spawn UNKNOWN` and `TOOLCHAIN_NOT_SANDBOX_COMPATIBLE`; these are not a clean background-success result. Rust parity also included a secure-runner self-test diagnostic with Winsock assertion 10107; the command completed and reported mismatches, but that runtime diagnostic must not be represented as merely a schema difference.

## Host AppData and cleanup evidence

Actual host path: `C:\Users\mon\AppData\Local\ThemisV2`. Before and after: **17,730 files / 826 directories**. Snapshot includes relative path, entry type, size and SHA-256, with sorted CSV serialization. Both CSV hashes: `DEEC7D434E851AF94802B554C7B11DD73910D932CB5BF0D1739F5C460B68F09F`; semantic diff count **0**. This CSV hash uses a different serialization from older reviews and is not compared directly to their tree digest.

Discovery-v2 remains 5,539 bytes, SHA-256 `5314E7F80FA0B25828CB1E9D91916BB6A51FC7623E71532E82EE91878F2BEC58`; WP0.1 hash `52A35F1BE3B92DF9D3B4FBF79AF14F2DE026A34771E2FC4D7246EA1B186338C7` is still unreconciled. All receipts/config files in the snapshot are unchanged during this review.

Retained artifacts: `artifacts/wp0.2/independent-round4/appdata-before.csv`, `appdata-after.csv`, `check-full.log`. Final process audit found no relevant test server, Cargo/Rust child or contract-test Node process, hence no listeners owned by these processes. Two pre-existing contract roots remain as listed above. Reviewer evidence staging directory `C:\Users\mon\AppData\Local\Temp\judgedesk_wp02_review_20260920_round4` also remains: automatic execution policy rejected the requested removal after evidence was copied into the repository. It contains evidence, not an active backend/test environment; cleanup is not claimed complete for this directory.

## Verification limits and handoff

- No test:desktop, Computer Use or macOS SSH was necessary to decide the WP0.2 lifecycle defects. UI changes elsewhere in the dirty checkout were not attributed to this remediation.
- Production binary source/build exclusion is verified; native directory-dialog and workbook-launch negative behavior were not independently exercised against a running release binary in this round. Submitted Node negative probe injects a picker and is not equivalent to testing the native default.
- Cargo tests ran using their existing root management, not a new outer redirected AppData/TEMP wrapper; the comprehensive host snapshot is unchanged, but fully enforced outer isolation is not claimed.
- Fresh-context adversarial review confirmed the actionable findings. Cross-model external CLI review was offered and the user declined.
- Antigravity should remediate these findings, retain reproducible fault tests, reconcile provenance and pre-existing roots, then resubmit WP0.2 as VERIFYING. Only a subsequent independent review can mark DONE. WP0.3 remains NOT_READY.
