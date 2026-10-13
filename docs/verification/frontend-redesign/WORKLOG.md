# Frontend redesign — Nhật ký nối tiếp

Append entries; không viết lại kết quả cũ thành PASS.

## FR-LOG-0001 — 2026-10-03 — Plan và intake

- Người dùng yêu cầu plan lưu bền vững, khảo sát bản cài v1.5.1 bằng Computer Use
  trước sửa; sau mỗi đợt frontend dùng test:desktop để xem bản mới.
- Đọc computer-use SKILL và guidance/api/confirmations; khởi tạo @oai/sky trong
  node_repl thành công. Không dùng CUA browser API để điều khiển native app.
- list_apps không trả JudgeDesk. Chưa có quan sát UI JudgeDesk ở thời điểm này.
- Đọc token, toolbar/scoreboard source và modal inventory để lập scope; nhận
  thấy UI_UX_DESIGN có giá trị token lệch source. Đây là source findings, chưa
  phải kết luận visual baseline.
- git status có nhiều dirty files migration Rust/backend. HEAD và trạng thái
  được lưu trước thay đổi; chỉ thêm tài liệu frontend riêng trong lượt này.
- Các files mới: frontend-redesign-plan.md, STATUS.md, WORKLOG.md, BASELINE.md.
- Documentation review: scope, recovery, evidence, commands và migration
  separation đã đối chiếu. Chưa thay runtime; chưa chạy tests/build.
- Next: tìm bản cài, khảo sát/chụp màn chính và modal quan trọng; ghi thiếu sót
  trung thực trước khi bắt đầu FR1.

## FR-LOG-0002 — 2026-10-03 — Khảo sát sơ bộ bản cài

- Tìm bản cài bằng uninstall registry/read-only filesystem; mở bằng sky.launch_app.
- Chọn đúng window từ list_windows, UI xác nhận v1.5.1 / 4d6c068324a3 / local.
- Quan sát và lưu 7 PNG qua screenshot API để phục vụ evidence/recovery.
  Có main empty và Tools light/dark, manager ready light, OSD off light.
- Ghi manifest, reproduction và limitations trong BASELINE.md; cập nhật STATUS.
- Không nạp contest thật, không chấm, không xoá, không đổi bộ công cụ hoặc bật
  watcher. Phục hồi dark/VI và đóng menu/modal; app vẫn mở.
- Cẩn trọng capture trong transition: light Tools cần ảnh steady bổ sung; không
  kết luận theme bug từ một frame. Cursor glow chưa xác định nguồn.
- Next: fixture riêng cho populated scoreboard/Problem config, các modal còn
  lại và dark counterparts. FR0 vẫn IN_PROGRESS; plan/recovery setup DONE.
- Không sửa source runtime; không chạy test:desktop trong lượt tài liệu này.

## FR-LOG-0003 — 2026-10-03 — Fixture và Problem configuration (đang khảo sát)

- Người dùng cung cấp thihay-l2 và stress_test_judge để tiếp tục FR0.
- Tạo bản sao riêng tại D:\Minh\Code\judgedesk-ui-audit\20261003: stress có
  20 bài, 9 contestants (AC_cpp, AC_python, WA_cpp, CE_cpp, RE_cpp, TLE_cpp,
  Weighted_Partial_cpp, Group_PassAll, Group_PassA_FailOneB); không copy fixture
  Sec_*/ZZ_DANGEROUS_*. thihay có 5 bài, 15 contestants đổi tên Audit_01..15.
- Không copy đề thi DOCX, ảnh danh sách thí sinh hoặc _temp_judge của bộ thật.
- Mở bản cài đúng executable bằng Computer Use; lần chụp đầu bị occlusion bởi
  Codex, không lưu ảnh đó. activate_window rồi reobserve đã khắc phục.
- Nạp stress copy qua dialog F2/F3; chụp dark/light scoreboard, menu bài,
  Problem configuration: top, testcase, nhóm/policy, nội dung và interactive.
- Toggle nhóm/interactive chỉ trong modal, không lưu vào Config.cfg. Modal dark
  đã huỷ; light đang mở để khảo sát. Không sửa source runtime.
- Evidence mới có manifest JSON tại artifacts/FR0/manifest-20261003-session2.json.
- Quan sát: header scoreboard chia tên bài thành 1–3 ký tự/dòng; vùng settings
  cố định trong Problem config chiếm khoảng nửa modal; bảng chỉ còn vài dòng.
- Remembered picker ban đầu: tests C:\Users\mon\Downloads\TEST-l2-huong;
  contestants C:\Users\mon\Downloads\THI-TRUONG-LAN 2-26-9-2026.
- Next: huỷ modal light, lấy judging/progress/details/log/diff bằng stress copy;
  tiếp tục thihay và các modal phụ, ghi kết quả cuối vào STATUS/BASELINE.

## FR-LOG-0004 — 2026-10-03 — Baseline đại diện hoàn tất

- Hủy mọi config modal, không lưu group/interactive changes. Chấm chỉ A_plus_B
  trên stress copy để lấy AC/WA/CE/RE/TLE; chụp progress, WA diff, CE, aggregate log.
- Lưu stress-baseline.judgedesk qua native Save As (440636 bytes), UI lưu hoàn tất.
  Native dialog UIA set_value không truy cập cached element; dùng quan sát focus
  filename + keyboard để nhập path đã biết. Không lưu screenshot thư mục Downloads.
- New contest rồi nạp thihay copies 15x5, chụp light/dark main, CAU1 File I/O
  config và Help light; config Hủy. App hiện light/VI thihay chưa chấm, modal đóng.
- Tổng 33 PNG (7 ban đầu +26 mới), manifest phiên 2. Hai tên ảnh cần phân biệt:
  details-WA chỉ focus scoreboard, details-WA-open mới là dialog; config-groups
  light là vùng test thấp, config-group-policy mới là chính sách nhóm.
- AUDIT.md ghi UI-006..012, coverage debt, fixtures, định hướng FR1 và gate.
  BASELINE.md là inventory ban đầu; cập nhật đọc cùng AUDIT/manifest phiên 2.
- FR0 DONE ở mức representative, không phải toàn bộ acceptance. EN/narrow/focus/
  contrast và dark secondary prompts vẫn cần trước FR7. FR1 tiếp theo.
- Review tài liệu theo code-review-and-quality; chưa sửa runtime, chưa test:desktop
  hay runtime gates. Không sửa migration có sẵn hoặc thêm dependency.

## FR-LOG-0005 — 2026-10-03 — FR1 alternatives and project skill

- Read source Scoreboard, ProblemConfigModal, BasicProblemSettings and index.css.
  Diagnosis and preservation risks in DESIGN.md. Existing frontend has no user
  edits at intake; unrelated migration remains untouched.
- Read redesign-existing-projects/minimalist-ui and skill-creator. Wrote concise
  judgedesk-frontend project contract and changed only UI dispatch row in dirty
  AGENTS.md; preserved other existing modifications and supporting skills.
- Consulted evondevKit ui-ux at HEAD 91337028ceeaf828c4d420b2f75fd1515bcf2b85.
  GitHub web open failed; raw source read succeeded. No remote code copied/run.
- Added standalone light-options.html with A/B, 5/20 columns and config sections;
  no production route, runtime frontend change, save/judge connection or dependency.
- Browser file URL rejected by security policy; no workaround attempted. File
  panel opening queued. Prototype render/interactions NOT_RUN, no FR1 screenshots.
- Prototype JS syntax PASS; git diff --check exit 0 (CRLF warning only).
  quick_validate.py failed missing PyYAML; no install, manual skill review only.
- FR1 remains IN_PROGRESS for preference/render validation. Recommend A: dense
  table + horizontal config sections. Native test:desktop required for each later
  production frontend batch; not run for documentation/prototype alone.

## FR-LOG-0006 — 2026-10-07 — ProblemConfigModal tabs implemented

- User accepted direction A and plan critique; amended problem-config-modal-plan.md
  before implementation: isolation, accessibility, validation/error visibility,
  viewport bounds, exact summary, palette contrast and verification limits.
- Managed worktree C:\Users\mon\.codex\worktrees\judgedesk-frontend\judgedesk,
  branch codex/frontend-redesign at 23290be (v1.5.3). Original main backend/vi.json
  dirty changes retained; production frontend untouched there. No commit/merge.
- Three CSS-hidden mounted tabs reuse children/save hook. VI/EN summary, helper/SSR
  tests added; no dependency/lock changes.
- Native RED found global Escape closing main behind popup. Centralized config
  keyboard ownership, removed duplicate nested listeners, respected Help above it.
  Review fixes keep both errors visible and tab focus rings inset.
- Native RED found removed menu opener could not regain focus. Saved scoreboard
  trigger fallback; fresh 960x600 build verified return focus.
- Native QA: invalid compile draft/Save blocker across tabs, retained editor state,
  keyboard/nested dialogs, rational save on fixture copy, Light/Dark VI/EN and
  short viewport. Restored copy Config.cfg; did not clear scored results.
- Final check:fast PASS; test:server 780 tests / 770 pass / 0 fail / 10 existing skips;
  API contracts 48/48 PASS; version lockstep PASS unchanged 1.5.3; diff check PASS.
  Prior timeout and direct-node environment error documented; no gate weakened.
  check:full pending before future commit/push.
- Independent review complete; user skipped cross-model review. Native macOS,
  fault/busy injection and long-name checks NOT_RUN.
- Details: problem-config-modal-implementation.md; Escape RED/GREEN:
  modal-escape-regression.md; evidence: artifacts/FR4-modal/manifest.json.
- Preview left running light/VI Basic A_plus_B on stress baseline 9x20, results
  retained. Reacquire native window; never reuse old handles/indexes.
- FR4 remains PARTIAL overall: modal tab batch done; child polish/results remain.

## FR-LOG-0007 — 2026-10-07 — Main integration / source 1.5.5 (complete)

- User authorized merge into main and source-only version bump; explicitly excluded
  release preparation/activation. No packaging, tag, push, release notes or publishing.
- Prepared actual main candidate before commits; retained five dirty backend files
  byte-for-byte and all 609 previous VI translation values. Local before snapshots
  and JSON-key merge saved in ignored artifacts/merge-155/.
- Eight authority version files synchronized to 1.5.5. Core lock dependency reference
  and two API snapshot appVersion fields also synchronized, no dependency upgrades.
- Version and fast gates PASS. Checker parity PASS in all four tiers (67 fixtures).
- Full gate hit derived lock mismatch, then core harness failures: stale1.5.3 binary,
  frozen SHA requirements and owned-root assumptions. Native/Tauri fmt/clippy/tests
  and core fmt/clippy PASS. No freeze/security/test policy changed to get green.
- Server UI/version-only suite PASS: 780 tests, 770 pass, 0 fail, 10 existing skips.
  Combined main suite has five failures in its existing backend work (783 tests).
  User explicitly authorized a scoped check:full exception for this integration.
  Create separate UI/docs and version commits; exclude five backend files and keep
  local VI changes; no push, tags or packaging. Final status follows after main
  advances. Detailed state and logs in merge-main-155.md.

### FR-LOG-0007 completion — after commits on main

- Applied user-authorized scoped check:full exception (2026-10-07), only for this
  integration; no quality/security/test policy changes or new skips.
- Commit 1 66988969dd3db4d6d8064e02f219d659461a5f18: UI + regression tests + related docs (17 files).
- Commit 2 70b8411c1bf1149e448bf8d700204bca36f6a0ab: 8 authority files + derived core lock + 2 API goldens
  (11 files, 13 metadata lines). No dependency upgrades.
- Main fast-forwarded from 23290be to Commit 2. Five backend files excluded from
  both commits; their hashes match before.json. Exact local merged VI bytes and
  all 609 previous values retained; original local translation edits uncommitted.
- Git overlap protection required restoring only verified owned candidates to base
  and refreshing baseline index entries; all candidates backed up. No backend
  file staged/restored, no stash, reset, forced merge or dropped user changes.
- Updated STATUS/WORKLOG/merge-main-155 after completing both commits on main;
  these completion log changes remain uncommitted to keep exactly two scoped
  commits, mirrored to worktree for reliable resumption.
- No git push, tags, packaging, publication or release activation. Wider frontend
  redesign remains partial; full-gate exception does not carry to future work.

- Post-merge final observation: storage.ts received an independent local backend
  edit after the merge-time hash verification: getExecutorCacheToolchainsDir now
  honors THEMIS_APP_DATA_DIR before OS defaults (three added lines). This agent did
  not write/stage/restore it; newest contents remain uncommitted and excluded from
  both commits. Other four backend hashes still match before.json. Local evidence:
  artifacts/merge-155/post-merge-external-storage.ts; observed SHA256 c89e5f316d4bd2be424ba75eb9dd0c70a8e5453719fee12cd2c7345414ae63b9.
- Final checks on main PASS: check:fast and release:check-version (1.5.5).

## FR-LOG-0008 — 2026-10-07 — Tests / quick groups and group points

- User approved the spec and implementation directly on main, without a new
  branch/worktree or external-model review. Self-review and RED/GREEN regression
  tests were used. Existing unrelated backend, Rust harness and VI edits retained.
- Tests tab label is identical in VI/EN. One control row contains Test well-formed,
  Enable groups and Show content. Quick selection uses the visible natural-order
  one-based # positions, accepts whitespace/reversed intervals, deduplicates, and
  rejects invalid/out-of-range selections atomically. Blank name ungroups as a no-op
  where appropriate; points/time limits remain. Apply changes the modal draft only.
- Group Edit replaces its member list, formats intervals, preserves unequal points
  on membership-only edits and links group total/per-test scores with rational math.
  Transparent interaction barrier blocks background clicks, forwards outside wheel
  scrolling, and restores Edit focus on nested Escape. Empty groups remain visible;
  missing/empty dependencies block Save and fail closed in both scoring backends.
- Read-only well-formed validation streams 64 KiB byte chunks, bounds diagnostics,
  accepts LF/CRLF, and applies only to discovered inputs. It runs on toggle, Save,
  batch judging and Node OSD. Rust OSD remains its preexisting unsupported endpoint.
  Shared API types live in shared/contracts.ts. Atomic Config.cfg replacement uses
  unique temporary files; invalid Save preserves the old config byte-for-byte.
- Self-review found Rust POST previously ignored validateOnly and wrote preview
  requests. A failing HTTP regression demonstrated the defect, then both backend
  implementations were brought into parity. Rust validation runs off the HTTP
  executor thread and is reused before its batch session executes submissions.
- Feature files: src/components/ProblemConfigModal{,.test}.tsx;
  src/features/problem-config/{test-selection{,.test}.ts,editor-state{,.test}.ts,
  useProblemConfigEditor.ts,GroupEditDialog.tsx,GroupPolicyTable.tsx,
  TestConfigurationTable.tsx}; src/locales/{en,vi}.json;
  shared/{contracts,problem-config}.ts; server/problems/{test-wellformed{,.test}.ts,
  problem-config-repository.ts,problem-config.test.ts}; server/routes/problem-routes{,.test}.ts;
  server/judge/{judge-session.ts,osd-service.ts,scoring{,.test}.ts}; Rust core discovery
  validator/module, server, session, scoring and associated server/scoring/validator
  tests. BACKEND_SCHEMA and API manifest/inventory/matrix updated.
- Native test:desktop QA used only the existing fixture copy at
  D:\Minh\Code\judgedesk-ui-audit\20261003\stress\test. A_plus_B has five tests.
  Apply `1-2, 4-3,2` to QA selected four tests. Edit `1-2, 5` and total `9/2`
  produced three tests at 1.5 points, group total4.5 and problem total6.5.
  Config.cfg SHA256 remained D670F9184873C58E587C2613C0AEF2B599C9E30AF20440F10BBBF181D630D44D
  through draft operations; outer Save persisted and reopen retained exact points.
  Invalid test05 validation blocked Save and retained the stored flag=false.
  Nested wheel/click/Escape/focus and light EN / dark VI were observed.
- Native QA found wrapped action labels when Show content was enabled. Deliberate
  column minimums and table scrolling fixed it; restarted desktop confirmed all
  action labels on one line at 1282x831. New points/focus colors tightened contrast.
- check:fast PASS. Initial official test:server PASS: 814 tests, 804 pass, 0 fail,
  10 existing conditional skips. Rust focused route/validation/scoring tests PASS.
  First check:full failed Tauri doc-test due to a missing .rlib while test:desktop
  concurrently shared its target directory. Stopped desktop; direct cargo doc-test
  PASS. Sequential rerun now passed all nine Rust fmt/clippy/test steps.
- Final check:full PASS (exit0): Rust 9/9 gates; official server suite815 tests,
  805 pass / 0 fail / 10 existing conditional skips; checker parity67/67 fixtures
  across Node/Rust/C++/packaged binaries; release:check-version1.5.5. Latest
  check:fast PASS; scoped diff --check PASS. Full log:
  artifacts/tests-config-check-full.log. No exception or lowered gate was used.
- Final desktop restarted using test:desktop with an existing-TEMP JSON overlay
  setting startup width960/height600/maximized=false, then used native window
  maximize/restore. Production tauri.conf.json unchanged. Backend65032, build
  identity1.5.5/main70b8411/dirty; log: artifacts/tests-config-desktop-final.log.
- Final native matrix PASS: light/dark × VI/EN × maximized1536x792/960x600 client
  (962x631 including native title frame). Three checkboxes share one row; footer
  remains reachable; tables scroll horizontally with single-line action labels.
  Screenshots are tool-captured evidence in this conversation. No extra dimming
  in Group Edit; Tab/Shift+Tab wrap, background click retains input focus, Escape
  returns focus to QA Edit. Well-formed diagnostics stay readable in narrow EN.
- Native empty-name Apply on already ungrouped #3 produced no error, retained its
  one point and total6.5. Invalid `1, 90` Apply displayed localized error and left
  #1 in QA at1.5; no partial mutation. Final UI trials were discarded; persisted
  config remains flag=false, total6.5 and the earlier QA assignment. All five input
  hashes remain unchanged. UI left running light/VI maximized on Tests A_plus_B.
- Contrast checks of the shared palette: muted text on elevated light4.55:1,
  elevated dark6.91:1; main action white/accent7.36:1; light focus/white6.37:1.
  New point text uses emerald700 in light and emerald400 in dark; dark focus uses
  emerald400. Native macOS, explicit fault/busy injection and long-name limits
  remain NOT_RUN. Broader redesign stays partial; this feature batch is complete.

## CE/JE hardening — pause checkpoint 2026-10-12

- User requested a safe stop for quota at 09:28 ICT; no further implementation
  or test run started. All dirty changes/evidence preserved; no commit/push.
- Files cover shared CompileStatus, compiler error provenance/Java validation,
  judge session/scoring, scoreboard model/view, judging details/log, workbook,
  EN/VI strings, regression tests and corpus expectations. No redesign or new
  dependency. Full file inventory remains available in git status.
- Relevant focused tests and check:fast passed. Latest full run: Rust 9/9 PASS;
  server 864 tests, 853 PASS, 1 stale corpus assertion FAIL, 10 existing skips.
  Final JE harness fix awaits full rerun; scoring 14/14 PASS after that fix.
- Native fixture is synthetic Audit_01 with Runtime/Setup/Syntax/Valid. JE total
  is not a grade; runtime compile OK and AC testcase 0.5 remain visible. Removing
  both JE problems restores valid total1.00. Owned fixture saved/reopened without
  changing testcase results. Production Tauri config unchanged; narrow launch
  uses artifacts/ce-je-ui/narrow-config.json.
- Normal 1536x792 light/dark × VI/EN screenshots saved; narrow 962x631 including
  native frame dark EN/light EN saved. VI narrow remains pending. Enter opens
  details; Escape closes with visible cell focus. Tab containment not proven.
  No comparable CE/JE before baseline; macOS NOT_RUN. Screenshot directory:
  artifacts/ce-je-20261012/ relative to this directory.
- Static new-JE palette contrast estimates exceed normal-text 4.5:1, but this
  is not native CSSOM measurement or a whole-app accessibility certification.
- Existing AppToolbar setState-in-render warning recorded, not changed here.
  Executor code0 exit occurred during concurrent corpus testing; standalone
  narrow session subsequently remained Ready. Root cause not established.
- Closed desktop normally: session36261 exit0, sidecar code0; process check
  confirmed no app/server/native executor. Preferences remain light/EN.
- Resume only on user instruction: finish missing native audit, close desktop,
  rerun full gate sequentially and check frozen artifact/source receipt before
  accepting step2. Steps3–6 not implemented; OSD deferred. Detailed checkpoint:
  ../../reports/judgedesk-hardening-progress-2026-10-12.md.

### Resume and local policy batch — 2026-10-12

- Completed remaining narrow VI CE/JE observations and restored dark/VI. Native
  screenshot matrix scoreboard8 states; no macOS/before baseline claim.
- Step2 full gate exit0, server854 PASS / 0 fail /10 existing skips, parity67,
  Rust9/9. Post-gate frozen952320-byte executable and30 inputs matched receipt.
- Confirmed existing details Tab escape to background checkbox; recorded scoped
  debt instead of labeling the whole keyboard/accessibility audit PASS.
- Step3A adds LocalExecutionPolicyNotice using existing Notice warning surface
  and VI/EN keys; no weaker-isolation toggle. Themis import no longer PUTs policy.
- useToolchains central refresh restarts pending polling. Host refresh extracted
  into small owned controller; behavioral RED proved queued B lost after failed A,
  GREEN3/3 verifies servicing B, automatic settlement/no flicker and disposal.
- Policy9/9, cache6/6, migration10/10, routes11/11, manager11/11 focused PASS.
  Two existing skip fingerprints rebound to LF test bytes only; no waiver changes.
- Native step3 and full gate still pending; step3B roles/cancel-drain not implemented.
# Local policy 3A gate closure — 2026-10-12

Full gate artifacts/local-policy-3a-check-full-20261012.log exit0, 882 tests /
872 pass / 0 fail / 10 existing conditional waivers; Rust9/9, parity67 four tiers,
version1.5.5. Final fast log artifacts/local-policy-check-fast-final-20261012.log.
Latest focused counts: policy10/10, host refresh4/4 (earlier3/3 record superseded).
Post-gate receipt30/hash/size match. No native3A PASS: desktop launch used owned
artifacts/local-policy-ui AppData, but user Escape stopped Computer Use before
window selection. Stop automation immediately; no3A screenshots captured.
Next native task: notice VI/EN light/dark normal/narrow plus compiler auto-refresh;
do not touch actual user compiler preferences or security settings.

## Local policy 3A native closure / 3B checkpoint — 2026-10-13

- User restored Computer Use; two dev rebuilds and all8 notice matrix states
  observed, plus local selection pending -> incompatible without manual Verify.
- Owned AppData only; no real contest/download/install/security toggle. Dark/VI
  restored; normal and960x600 client apps closed normally, sidecars exit0.
- Full screenshot hashes, build timestamps and scoped limits in
  local-policy-3a-native-20261012.md. No complete focus-trap/return-focus proof,
  narrow table/toolbar overflow remains; macOS NOT_RUN, no before comparison.
- 3B owns probes through cancel/drain, requires generated submission/checker and
  Python runtime roles. Focused22/22 and IPC30/30 GREEN; three bounded reviews.
- Real original-path GCC/Python probes fail closed, not native positive PASS.
  Controlled-copy gate only diagnoses role pipeline vs source-path access.
- Full gate interrupted by Modern Standby TLE timeout; focused TLE passed2,30s.
  Full gate retry is pending; no gate weakening or skip introduced.

### Final 3B code gate closure — 2026-10-13

- Sequential final check:full exited0: fast, Rust9/9, server902 PASS /0 fail /
  10 existing skips (912 total), corpus25, parity67 across four tiers, version1.5.5.
- Post-gate frozen30 inputs and952320-byte executor SHA-256 matched receipt;
  git diff --check passed. No commit/push, dependency, version or new skip.
- Corrected owned-root copy gate4/4 validates real native role pipeline only;
  corrected original-path gate0/4 remains a failing product criterion.
- No new desktop positive-compiler observation; preserve scoped3A UX acceptance
  and recorded accessibility/macOS limits. Full step3 and steps4–6 remain open.
