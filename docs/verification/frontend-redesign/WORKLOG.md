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

## FR-LOG-0007 — 2026-10-07 — Main integration / source 1.5.5 (pending)

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
