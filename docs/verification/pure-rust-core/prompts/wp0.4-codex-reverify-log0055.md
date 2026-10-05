# Prompt — Codex mới: review độc lập WP0.4 sau LOG-0055

Bạn là reviewer/verifier độc lập WP0.4 của JudgeDesk Pure Rust Core. Chỉ bắt đầu sau khi Antigravity tạo một submission `VERIFYING` mới, cập nhật đồng bộ `STATUS.md`, report và WORKLOG. Làm trong saved checkout `D:\Minh\Code\judgedesk`; không tạo worktree, reset/stash/clean, commit/push, đổi version, sửa production/test để tự nghiệm thu, đóng G0 hoặc bắt đầu WP0.5.

## Bối cảnh bắt buộc

- LOG-0055 kết luận `IN_PROGRESS` vì intake lúc đó không có handoff `VERIFYING`: STATUS là IN_PROGRESS, WORKLOG mới nhất là Antigravity claim LOG-0054, report ghi “opened, not submitted”, ADR còn PROPOSED.
- Sau claim LOG-0054, checkout đã tiến tới HEAD `8bc8ac9a2161a7468b633c421185d039c97e5a68` (trước đó `b09f77bbaa387845271847b9297851be5b5345d7`), còn dirty với các file implementation/evidence chưa commit. Đó chỉ là intake snapshot LOG-0055; không giả định source mới giữ nguyên.
- Implementer report tự khai feature-gated Platform, Rust IPC ExecutorClient, UUID token qua `JUDGEDESK_EXECUTOR_TOKEN` và 10 boundary tests. Đây không phải bằng chứng reviewer. Hãy so current VERIFYING submission với đúng accepted WP0.3 dirty baseline và nguồn evidence đóng băng của chính submission.
- Source version baseline là 1.5.1; chỉ WP10.3 được phép bump tám file đồng bộ lên 1.6.0.

## Quy trình

1. Trước tiên đọc `AGENTS.md`, `guidelines.md`, `CONSTRAINTS.md`, `docs/pure-rust-core-start-here.md`, `docs/verification/pure-rust-core/STATUS.md`, WORKLOG và log bàn giao mới nhất; efficient-execution, Antigravity handoff và detailed implementation plan (đặc biệt WP0.4/WP0.5 dependencies); ADR 0001; WP0.4 report; prompt nghiệm thu WP0.4 gốc `prompts/wp0.4-codex-verify.md`; và submission evidence mới nhất. Áp dụng review/quality, doubt-driven, security/hardening, constraints và debugging skills phù hợp.
2. Xác nhận latest authoritative state thực sự là `VERIFYING`. Nếu không, báo đúng trạng thái và dừng acceptance. Nếu có, ghi reviewer claim bằng LOG ID thực tế tiếp theo. Chụp dirty inventory, HEAD, source/test/build/package hashes/mtimes; phân biệt accepted WP0.3 baseline và WP0.4 diff; không dùng HEAD đơn lẻ. Bất kỳ source change nào trong review đều làm mất freeze và phải ghi nhận.
3. Review ADR trước khi chạy command: đối chiếu production call graph, Rust feature graph, package/build output và test helpers. Với từng dòng dưới đây, xác định production path, assertion và evidence thật; ADR prose, test names, regex, hay mock xanh không chứng minh runtime:
   - release core không thể chạy `Platform` in process qua production/alternate feature, helper, hoặc fallback;
   - dùng exact packaged executor; binary thiếu/không tương thích trả unavailable, không fallback in-process/compiler;
   - Node/Rust tương thích legacy framed-v1: length LE 4 byte khác 0, giới hạn 1 MiB, correlation, malformed/truncated/oversized/unknown-message failure;
   - sai OS parent/generation bị từ chối trước readiness trên Windows và macOS (UUID trong environment tự nó không xác thực parent);
   - startup đồng thời chỉ tạo một executor client/generation guard;
   - cancel bao phủ reservation đã accepted và run đang active; completion chỉ sau native drain thật;
   - protocol failure/crash dừng admission và không replace generation khi process được sở hữu có thể còn sống;
   - parent EOF không để lại process, port hoặc root thuộc executor;
   - updater handoff đợi đến khi native ownership được giải phóng;
   - Node rollback dùng cùng compatible packaged executor boundary với generation ownership loại trừ lẫn nhau.
4. Lập coverage matrix ánh xạ từng WP0.4 exit criterion sang source, executable path, assertion và test/evidence. Tách đúng integration của WP1.1/WP1.4/WP1.6/WP4.3/Phases 3–5; không kéo package sau vào review, nhưng cũng không nhận lời hứa tương lai thay exit criterion WP0.4. Bảo đảm rational scoring, sandbox fail-closed, no compiler fallback, Rust runtime no unwrap/expect, RAII, strict TS/ESM, và không hạ gate/xóa/skip test.
5. Trước build/runtime/stateful test đầu tiên, snapshot **C:\Users\mon\AppData\Local\ThemisV2** và **C:\Users\mon\AppData\Local\JudgeDesk\JudgeDeskExecutor** theo đúng protocol: path/type/size/per-file SHA-256, aggregate, semantic state, relevant processes/ports/owned roots/security state. Dùng writable roots riêng có owner/containment đã kiểm chứng; không đụng host data. Chạy chọn lọc các probe bác bỏ claim trước; chỉ nếu candidate vượt qua mới chạy đúng một lần thành công `npm run check:full` trên final frozen source. Chạy riêng fmt, all-target clippy `-D warnings`, locked Rust tests và platform/security checks chưa bao phủ bởi gate; kiểm tra inventory/skips/actual assertions.
6. Sau từng scenario kiểm tra cleanup; serialize suites dùng chung host state. Quan sát 5–10 giây, so sánh full before/after của cả hai AppData roots và reviewer-owned roots. Giữ raw deltas; FALSE không phải equality. Snapshot cuối phải khớp đúng source đã chạy. Windows không thay macOS; static parity không thay live/platform execution. Fail/interruption/source change cần giữ logs và rerun phần bị mất.
7. Ra đúng một verdict: `DONE` chỉ khi WP0.4 exit criteria/evidence đầy đủ; `IN_PROGRESS` cho defect trong repo; `BLOCKED` chỉ prerequisite bên ngoài thực sự chặn. Cập nhật STATUS, report, ADR status và append WORKLOG bằng ID thực tế; giữ nguyên history/failed logs. Không tự sửa implementation để đổi verdict. Tạo hai prompt tiếp theo: remediation/reverification WP0.4 nếu IN_PROGRESS, hoặc implementation/review WP0.5 nếu DONE.

Không gửi tin sang conversation khác. Dừng sau khi hoàn tất verdict, ledger và hai prompt tiếp theo.
