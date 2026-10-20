# N0 candidate12 remediation notes — evidence and investigation leads

These notes support the [revised dispatch](n0-c12-audit-remediator-20261018.md). They are source research and guidance, not a remediation run, a restored-file receipt or a changed verdict.

## What is proved

- The original Windows inventory has a changed preference-file digest. The actual before and after bindings are in [intake-validation.json](../artifacts/n0/codex-scoped-review-20261017T174658Z/intake-validation.json); the original snapshots are in `artifacts/n0/antigravity-remediator-20261017T122212Z/`.
- The historical `snapshot-protected-roots.py:183–196` compares size and current document shape, not before/after values. The [owned falsifier](../artifacts/n0/codex-scoped-review-20261017T174658Z/audit-comparator-falsifier.json) reproduces the false PASS. This proves a defective audit; it does not prove the real preferences changed semantically or identify the historical writer.
- All original declared candidate/artifact bindings validated, and the reviewer found no new high-confidence production defect in the native cleanup change. The last review deliberately stopped at preservation intake; native and packaged acceptance still require independent execution.

The historical synthetic falsifier uses generic `selected` entries. Preserve it as evidence of the old comparator's weakness, but add schema-valid fixtures using `ProfilePreferenceEntry`'s actual `mode` and `localPath` fields. Otherwise a new schema validator could reject that old fixture without proving that it compares real preference values.

## Starting points for writer attribution

| Source/symbol | Observed behavior | Investigation implication |
|---|---|---|
| `crates/judgedesk-core/src/toolchains/discovery.rs` — `get_app_data_dir()` | Nonempty `THEMIS_APP_DATA_DIR` takes precedence over `LOCALAPPDATA`; Windows has further ambient fallbacks. | Setting only LOCALAPPDATA does not isolate persistence if THEMIS_APP_DATA_DIR points elsewhere. Capture all effective inputs. |
| `crates/judgedesk-core/src/server/state.rs` — `ToolchainStore::from_app_data_dir_opt(None)` / `effective_app_data_dir()` | Constructor resolves the environment to read preferences but stores `app_data_dir: None`; later persistence resolves the environment again. | A constructor-only environment guard can isolate initialization yet allow a later mutation to resolve another root. This is a testable hypothesis, not attribution of the original incident. |
| `crates/judgedesk-core/tests/common/mod.rs` — `OwnedTestEnvironment::with_isolated_roots()` | Temporarily replaces LOCALAPPDATA/APPDATA/temp variables, omits THEMIS_APP_DATA_DIR, and restores the environment when the closure returns. | Inspect the full lifetime of state/server operations. Reuse this helper where appropriate, but prove its contract covers persistence as well as platform construction. |
| `crates/judgedesk-core/tests/server_test.rs` — `test_embedded_axum_server_full_suite` | Constructs `AppState` inside that closure, then starts the server and changes profile preferences later; no explicit `set_app_data_dir` at that construction site. | Start here for a harmless two-owned-root reproduction. Similar construction exists in `toolchain_diagnose_test.rs`; audit all callers before deciding the repair. |
| `crates/judgedesk-core/src/server/routes/toolchains.rs` — preference/custom-path/install/uninstall handlers | Call `persist_selections()` on the store. | Check the effective root at actual mutation time, including async workers, rather than inferring it from startup. |
| `crates/judgedesk-core/src/toolchains/discovery.rs` — `save_persisted_preferences_in()` | Serializes HashMaps and atomically renames the temporary preferences file. | HashMap order can explain byte differences but is not proof that it explains this incident. Do not change serialization order as a substitute for fixing isolation. |
| `crates/judgedesk-core/tests/common/mod.rs` — `ensure_test_environment()` / `init_windows_test_desktop_acl()` | The test helper itself invokes Win32 security mutation calls. The historical Python helper separately grants Everyone and package SIDs broad access. | Inspect both execution paths before any claim that the test window leaves host security unchanged. This note adds no new security verdict or permission. |

A useful owned regression keeps directories A and B entirely inside its private workspace: construct state under A's controlled environment, restore/change the environment to B, mutate a real preference through the affected caller, and assert the intended explicit root receives the write while B stays byte-identical. Decide whether the owning test should pin a root explicitly or the shared helper/state contract needs repair only after inspecting all callers. Do not use the real protected directory as B.

## Comparator result contract

| Scenario | Raw equality | Semantic result | Preservation result |
|---|---|---|---|
| Same trusted bytes, valid JSON | true | true | May pass if the rest of the inventory/security contract passes. |
| Different key order/whitespace, same complete JSON value | false | true | Record the write; cannot silently pass the original byte-preservation contract. |
| Same-length valid `localPath` changed from an owned A path to a same-length B path | false | false | FAIL, even with the same schema and twelve profiles. |
| Missing/unrecoverable before bytes | Known inventory result only | UNKNOWN / INCONCLUSIVE | Cannot close the incident. |
| Malformed JSON, duplicate keys, added/removed fields/profiles or changed value/type/schema | As observed | Invalid or different | Reject; do not project onto only known fields to erase a difference. |

Use both canonical profile IDs and aliases as the actual schema requires; derive fixtures from existing definitions. Keep aliases consistent when testing a valid change. Semantic comparison ignores JSON object ordering only; retain array order, scalar types, nulls, complete keys and literal strings. Keep the expected oracle independent of the new comparator and test the public comparison entry point, not just a JSON-normalization helper.

For original-content recovery, search preserved owned copies, already-retained archives and prior snapshots read-only. An archive should be inspected for the specific member without extracting arbitrary members. Recovered or reconstructed bytes must match the original before digest exactly and have their provenance/method recorded. Never overwrite the protected file merely because a candidate parses to a plausible document. If no matching input exists, report that precise evidence gap; a fresh inventory cannot supply it.

## Pending Mac command details

The mutation source is [candidate11 mac/mutation.json](../artifacts/n0/codex-scoped-review-20261017T111809Z/mac/mutation.json). Use its exact `originalFragment`/`mutantFragment` replacement with an exactly-one-match assertion. Do not copy candidate11's whole old controller over candidate12, which would discard the new regression. Include `rust-toolchain.toml` in the owned mutant workspace. The expected failing test is `preferred_cleanup_drains_buffered_prepared_after_cancel_broken_pipe`; compile errors, timeouts or missing tests do not count as its RED.

With verified private roots, current-source binaries and the existing required generation guard, the coupled interactive selection is:

```text
JUDGEDESK_RUN_GUARDIAN_FAULT_GATE=1
JUDGEDESK_INTERACTIVE_ADMISSION_GATE=1
JUDGEDESK_INTERACTIVE_SECURITY_GATE=1
node --import tsx --test --test-isolation=none
  server/executor-tests/macos-interactive-admission.integration.test.ts
  server/executor-tests/macos-interactive-lifecycle.integration.test.ts
  server/executor-tests/macos-interactive-preparation.integration.test.ts
  server/executor-tests/macos-interactive-security.integration.test.ts
```

This is an argv/environment inventory, not a directly executable multiline shell command. Use a bounded, reviewed harness. Confirm 74 tests and zero skips, not merely exit zero. For packaged gates, inspect actual launch environment forwarding and selected app identity; shell variables alone do not prove LaunchServices isolation. Do not blindly reuse historical scripts containing broad `pkill`, recursive cleanup, security modifications or cached-log-as-PASS shortcuts.

Optional native-test scheduling improvements remain nonblocking source-review suggestions. If implemented, demonstrate their own targeted falsifier and invalidate the affected native coverage. They are not a reason to expand N0 into unrelated toolchain features or later milestone work.
