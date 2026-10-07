# Main integration and version 1.5.5

Requested by user 2026-10-07: integrate config modal UI into main and bump source
version to 1.5.5. No release preparation, packaging, tag, push or publication.

Status: COMPLETE on main; source version 1.5.5. User-authorized scoped
check:full exception applied only to this integration.

## Scope and preservation

- UI batch from codex/frontend-redesign at base 23290be; tests and recovery docs.
- Eight application version files synchronized to 1.5.5, including both application
  package entries in src-tauri/Cargo.lock.
- Derived crates/judgedesk-core/Cargo.lock executor reference also updated; the
  independent core package version remains 1.5.1. Dependency versions unchanged.
- Two API golden snapshots change only build.appVersion to match requested version.
  No test normalization/assertion policy changed.
- Original main had five dirty backend files and eight existing VI translation
  edits. Backend files remain byte-identical and are excluded from commits.
  VI changes are merged by JSON key and retained as uncommitted local edits.
- Ignored recovery backup: artifacts/merge-155/before.json and before/ source copies,
  plus merged-vi.json. These are local snapshots, not staged source.

## Verification

- Version checker PASS at 1.5.5; worktree check:fast PASS.
- First full gate failed core --locked due to the derived executor reference still
  at 1.5.3. Native executor and Tauri fmt/clippy/tests passed. Corrected the single
  lock entry, preserving line endings; no gate was weakened.
- Full gate rerun on actual combined main candidate passed 8/9 Rust steps; core test
  step failed. Native executor and Tauri fmt/clippy/tests, core fmt/clippy all passed.
  Log:
  check-full-merge-155-final-20261007.log.
- Direct core test diagnostic identified stale binary EXECUTOR_VERSION_MISMATCH
  (expected 1.5.5 / actual 1.5.3), fixed SHA identity in executor_boundary_test.rs,
  and test roots not confined as expected by API/server/diagnostic harness tests.
  No runtime sandbox, freeze SHA, ledger or test assertions changed. Diagnostic:
  core-test-merge-155-diagnostic-20261007.log.
- Checker parity PASS: Node 67/67, Rust corpus, C++ 67/67, packaged binaries 67/67
  and manifest hashes verified. Log: parity-merge-155-20261007.log.
- All 609 prior VI translation values verified unchanged; five backend file hashes
  match preserved snapshots. Only 13 version metadata lines changed across 11 files
  (eight authority files plus derived lock and two API snapshots).
- Server suite on combined main candidate failed five pre-existing toolchain
  selection/storage tests (managed versus local_auto/none expectations). Dirty
  backend files remain unchanged and excluded from the proposed commits. Log:
  server-merge-155-20261007.log. Running the same official suite in UI worktree
  without those backend edits to verify only UI/version: server-ui-version-155-20261007.log.
  UI/version-only suite PASS: 780 tests, 770 pass, 0 fail, 10 existing conditional
  skips, exit 0 (150747 ms). Main working candidate: 783 tests, 768 pass, 5 fail,
  10 existing skips; failed files profile-state/resolver/storage-v2 are outside UI scope.
- User explicitly authorized a scoped check:full exception for this integration:
  separate UI/docs and version commits; exclude five backend files; preserve local
  VI edits; no push, tags or packaging. This does not waive gates for later work
  or change quality/test/security policy. Remaining failures above stay recorded.
- Previous Windows desktop behavior evidence remains in modal implementation log
  and FR4-modal manifest; no new UI behavior added in this integration/version step.

## Integration result

- Commit 1: 66988969dd3db4d6d8064e02f219d659461a5f18 — accessible Problem Config UI, tests and related docs (17 files).
- Commit 2: 70b8411c1bf1149e448bf8d700204bca36f6a0ab — version lockstep, derived lock and API golden snapshots (11 files / 13 metadata lines).
- Original main fast-forwarded from 23290be to Commit 2; no extra merge commit.
- Five backend hashes match before.json byte-for-byte. All 609 previous VI leaf
  values preserved; local VI delta remains uncommitted. Neither commit includes
  any of the five backend files or the local VI translation edits.
- Git initially refused overlapping working copies. Only verified UI/version/docs
  candidates were backed up and temporarily restored to base; refreshing those
  baseline index entries without content changes allowed the normal fast-forward.
  Protected backend files were never staged/restored. Exact merged VI bytes were
  restored in finally. Recovery copies remain under artifacts/merge-155/.
- STATUS/WORKLOG and this record updated after both commits on main. These final
  completion log edits remain local/uncommitted to retain exactly two scoped
  commits; copies also updated in redesign worktree for recovery.
- No push, tags, installers, packaging, publication or release activation.

## Resume

Main is now the v1.5.5 source baseline with this modal UI. Wider frontend redesign
remains partial. Read STATUS/WORKLOG before choosing the next UI batch; preserve
uncommitted backend/VI work. This exception does not apply to a future commit,
push or release: resolve or obtain an explicit decision on outstanding full-gate
failures before such work. Do not stage generated src-tauri/toolchains/ or ignored
verification artifacts.

- Post-merge final observation: storage.ts received an independent local backend
  edit after the merge-time hash verification: getExecutorCacheToolchainsDir now
  honors THEMIS_APP_DATA_DIR before OS defaults (three added lines). This agent did
  not write/stage/restore it; newest contents remain uncommitted and excluded from
  both commits. Other four backend hashes still match before.json. Local evidence:
  artifacts/merge-155/post-merge-external-storage.ts; observed SHA256 c89e5f316d4bd2be424ba75eb9dd0c70a8e5453719fee12cd2c7345414ae63b9.
- Final checks on main PASS: check:fast and release:check-version (1.5.5).
