# Prompt 2 — Codex mới: review và verify độc lập WP0.4

Bạn là **Independent Reviewer / Verifier** của JudgeDesk Pure Rust Core. Mon đã khôi phục phân vai: Antigravity implement/remediate, Codex review/verify. Chỉ review **WP0.4** khi Antigravity bàn giao `VERIFYING`. Không sửa production code/test để tự nghiệm thu; ngoại lệ tự nghiệm thu WP0.3 không áp dụng.

## 1. Xác định đúng bản bàn giao

Làm việc trong saved checkout `D:\Minh\Code\judgedesk`, gồm các thay đổi chưa commit đã được chấp nhận của WP0.3 và bản sửa WP0.4. Không reset/stash hay tạo checkout sạch làm mất các thay đổi này. Không commit/push hoặc đổi version. Tại lúc tạo prompt, WP0.1–WP0.3 DONE, WP0.4 IN_PROGRESS được bàn giao implement cho Antigravity tại LOG-0053; sau đó phải có submission VERIFYING mới. Source baseline tám file là 1.5.1; target 1.6.0 chỉ bump tại WP10.3.

Đọc theo thứ tự: `AGENTS.md`, `guidelines.md`, `CONSTRAINTS.md`; `docs/pure-rust-core-start-here.md`; `docs/verification/pure-rust-core/STATUS.md` và log bàn giao mới nhất trong `WORKLOG.md`; `docs/pure-rust-core-efficient-execution.md`; `docs/pure-rust-core-antigravity-handoff.md`; WP0.4 và quy tắc verification/dependencies trong detailed implementation plan; `docs/adr/0001-rust-core-executor-boundary.md`; `docs/verification/pure-rust-core/wp0.4-executor-boundary.md` cùng evidence của submission.

Áp dụng skills review/quality, doubt-driven development, security/hardening, constraints và debugging nếu cần. Dùng current ledger, không suy diễn submission đã tồn tại từ prompt. Nếu chưa VERIFYING, báo đúng trạng thái và dừng acceptance; không tự implement để tạo bản bàn giao. Khi đã VERIFYING, ghi reviewer claim với LOG ID thực tế tiếp theo; yêu cầu freeze có sẵn trong giao thức, không hỏi lại Mon quyền chạy verification.

Chụp dirty inventory và hash/mtime các nguồn liên quan, tests, scripts, fixtures, build inputs và binary provenance. Phân biệt baseline WP0.3 được chấp nhận với diff WP0.4. HEAD đơn lẻ không đủ. Antigravity không được sửa song song; nếu source thay đổi trong review, invalidate evidence liên quan và ghi rõ việc mất freeze.

## 2. Review nguồn trước, kiểm tra claim bằng đường production

Đối chiếu ADR với call graph/build/package thực tế:

- `server/executor/client.ts`, `protocol.ts`, `workspace.ts` — Node reference.
- `native-executor/src/main.rs`, `protocol.rs`, `request_validation.rs`, `tree_guard.rs` và guardian/controller thực tế trên Windows/macOS.
- `crates/judgedesk-core/src/server/mod.rs`, `engine/runner.rs`, `engine/session.rs`, `toolchains/diagnostics.rs` — các caller Rust trước đây dùng Platform in-process.
- `src-tauri/src/backend.rs`, startup/update guards, Cargo features/dependencies và sidecar packaging.
- Toàn bộ helper/test mới có thể mở đường thực thi khác hoặc giả lập evidence.

Khuyến nghị ADR là executor ngoài process qua typed framed IPC. Nếu đổi mô hình, phải chứng minh tương đương các yêu cầu crash/panic containment, guardian ownership, fail-closed termination, resource limits, cancel/drain và rollback. Không chấp nhận mô tả kiến trúc nếu release path vẫn gọi Platform trực tiếp hoặc fallback sang in-process/compiler khi IPC lỗi.

Kiểm tra protocol thật: frame length nonzero, little-endian 4 byte, tối đa 1 MiB; correlation, malformed/truncated/oversized/unknown messages và failure semantics. `executorVersion` không tự chứng minh wire negotiation; private pipe không tự chứng minh authenticated parent. Kiểm tra binding parent/generation theo từng OS, secrets không lộ vào log/environment student và tương thích Node rollback.

Phân biệt guard của executor generation với guardian/controller mỗi run. Readiness chỉ sau ownership hợp lệ; concurrent startup không nhân đôi owner; cancel bao phủ accepted reservations lẫn active jobs; ack/timeout không được giả là đã drain. Protocol lỗi/crash/parent EOF phải chặn admission và xử lý cây tiến trình trước replacement. Updater không được lấy exclusive handoff khi native ownership còn sống. Kiểm tra cache/workspace/package ownership, cleanup chống reparse/traversal, exact packaged binary và backend generation mutually exclusive.

ADR phải phân định phần đã chứng minh với integration WP1.1/WP1.4/WP1.6/WP4.3 và Phase 3–5. Không kéo các package đó vào review này; cũng không nhận lời hứa làm ở WP sau thay cho exit criterion WP0.4. Kiểm tra rational scoring, sandbox fail-closed, no compiler fallback, no runtime unwrap/expect, RAII, strict types/ESM và không hạ gate/xóa/skip test.

## 3. Verification độc lập, có chọn lọc rồi gate đầy đủ

Trước **stateful probe/build/runtime đầu tiên**, chụp baseline của chính reviewer: đầy đủ hai AppData roots ThemisV2 và JudgeDeskExecutor, per-file SHA-256 và semantic state, process/port/owned roots và security state theo giao thức. Dùng writable roots riêng có owner/containment được kiểm chứng. Không giết process toàn host, xóa temp tùy ý, hay dùng baseline mới để che delta cũ.

Lập coverage matrix và thực hiện probes/test độc lập cho từng claim:

1. Production release core không thể thực thi Platform in-process, kể cả alternate feature/test-helper/fallback path.
2. Exact packaged executor; missing/incompatible binary unavailable, không fallback.
3. Node/Rust legacy framed-v1 compatibility và strict decode/correlation/size/error boundaries.
4. Wrong parent/generation bị từ chối trước readiness trên các platform bắt buộc.
5. Exactly one guard/client generation khi startup đồng thời.
6. Cancel cả reservation và active run, kiểm chứng native drain thật.
7. Protocol failure/crash không cho replacement chồng generation còn sống.
8. Parent EOF không còn owned process/port/root.
9. Updater handoff chờ native ownership được giải phóng.
10. Node rollback đến cùng compatible packaged boundary, không dual execution.

Đối chiếu assertion thật của các test; tên test, regex source và mocked green response không đủ cho claim về execution/containment. Chỉ chạy hostile fixture sau khi xác nhận containment. Kiểm tra inventory/selection/skips để tránh zero tests hoặc unready runtime bị bỏ qua âm thầm. Bằng chứng Windows không thay thế macOS; static checker parity không thay live DLL/GUI/full migration parity.

Theo efficient-execution protocol: review source và các probe có khả năng bác bỏ trước. Nếu đã có defect quyết định, hoàn tất cleanup/audit rồi ra verdict; không cần chạy thêm full gate để xác nhận một candidate đã bị bác bỏ. Nếu candidate vượt qua, tự chạy **một lần thành công trọn vẹn trên final frozen source** `npm run check:full`, xác nhận các child bắt buộc thực sự chạy. Không lặp riêng check:fast/test:server/parity/version đã được gate đó chạy thành công cùng candidate.

Chạy riêng fmt, all-target clippy `-D warnings`, locked Rust tests cho các crate liên quan và security/platform/boundary checks bắt buộc chưa nằm trong check:full. Logs của implementer là đầu vào để điều tra, không phải reviewer PASS. Evidence reference chỉ dùng trong phạm vi được protocol cho phép, có original independent actor/execution/log hash, exact source/test/build/toolchain/environment identity, inventory/skips/assertions; không gọi reference là execution mới. Thiếu build provenance thì rebuild. Fail/interruption/source change cần giữ log và rerun tương ứng.

Serialize các suite dùng chung host state. Kiểm tra cleanup từng scenario; cuối window so sánh đầy đủ before/after và quan sát trì hoãn 5–10 giây. Giữ raw delta về reboot/PID/port/security, phân loại có chứng cứ; không viết FALSE thành equality. Snapshot nguồn cuối phải khớp bản được test. Không cấp conditional approval khi còn thiếu bằng chứng bắt buộc.

## 4. Một verdict và hai prompt vòng tiếp theo

Ra đúng một verdict evidence-backed:

- **DONE**: đủ exit criteria, required coverage và preservation; Codex độc lập chấp nhận ADR.
- **IN_PROGRESS**: defect trong repository cần Antigravity sửa; liệt kê finding ID ổn định, severity, file/line, repro, actual/expected, hướng sửa nhỏ nhất và regression cần bổ sung.
- **BLOCKED**: prerequisite bên ngoài thực sự ngăn hoàn tất; mô tả cụ thể điều kiện mở khóa. Không đổi defect có thể sửa thành BLOCKED.

Cập nhật STATUS, report WP0.4 với phần review/result độc lập, ADR status phù hợp và append WORKLOG bằng ID thực tế tiếp theo. Giữ nguyên lịch sử, failed logs và giới hạn evidence. Không tự sửa code để biến IN_PROGRESS thành DONE. Không tự đóng G0 hoặc chạy package sau trong phiên review này.

Sau verdict, **tạo hai prompt tự đủ context để Mon chuyển tiếp**, không dùng tool gửi tin sang conversation khác:

- Nếu IN_PROGRESS: prompt tiếng Anh cho Antigravity remediate **WP0.4 ONLY**, gồm toàn bộ findings/repro/regression và điều kiện submit lại VERIFYING; prompt tiếng Việt cho Codex mới reverify bản remediation đó.
- Nếu DONE: prompt tiếng Anh cho Antigravity tiếp nhận **WP0.5 ONLY** theo current READY/dependencies và explicit next-package claim; prompt tiếng Việt cho Codex mới review WP0.5 sau VERIFYING. Nêu đúng scope Rust gates/CI/expected skips và efficient-execution automation từ kế hoạch; không copy gate/test của WP0.4 thành acceptance WP0.5.
- Nếu BLOCKED: hai prompt mô tả prerequisite và phạm vi tiếp tục/reverify sau mở khóa, không cho phép nhảy package.

Phản hồi cuối gồm verdict, evidence/findings quan trọng, host/source limits, report/log locations và hai prompt vòng tiếp theo. Sau đó dừng chờ bàn giao của Mon.
