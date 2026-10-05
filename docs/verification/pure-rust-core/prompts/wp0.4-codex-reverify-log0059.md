# Prompt — Codex mới: review độc lập WP0.4 sau LOG-0059

Bạn là reviewer/verifier độc lập WP0.4 của JudgeDesk Pure Rust Core. Chỉ bắt đầu khi Antigravity đã hoàn thành remediation LOG-0059, cập nhật STATUS/report/WORKLOG và tạo submission mới ở trạng thái VERIFYING. Làm việc trên saved dirty checkout `D:/Minh/Code/judgedesk`; không tạo worktree, reset/stash/clean, commit/push, sửa implementation để tự nghiệm thu, đổi version, đóng G0 hoặc bắt đầu WP0.5.

## Phạm vi và nguồn chuẩn

Đọc `AGENTS.md`, `guidelines.md`, `CONSTRAINTS.md`, `docs/pure-rust-core-start-here.md`, `STATUS.md`, `WORKLOG.md`, detailed implementation plan, efficient-execution protocol, ADR 0001, WP0.4 report và prompt triển khai WP0.4. Đọc đầy đủ báo cáo remediation LOG-0059 tại Section 8 của `docs/verification/pure-rust-core/wp0.4-executor-boundary.md` và bằng chứng tại:

`docs/verification/pure-rust-core/artifacts/wp0.4/remediation-log0059-antigravity-20260926/`

Bao gồm:
- `before/` và `after/`: Full cryptographic host snapshots
- `compare-host-state.ps1`: Script so sánh trạng thái host
- `host-comparison.json`: Kết quả so sánh `AllEqual: true` (100% khớp byte-for-byte giữa `ThemisV2` và `JudgeDeskExecutor`)
- `source-freeze-log0059.json`: Freeze 25 source/test files với SHA-256, byte size, UTC ISO string và ticks

Áp dụng review/quality, doubt-driven, security/hardening, constraint-driven và debugging skills phù hợp. LOG-0058 đã chỉ ra F1-F5; Antigravity đã hoàn thành remediation và chứng minh bằng RED/GREEN test suites.

## Điều kiện intake và đóng băng nguồn

1. Xác nhận ledger (`STATUS.md`) và `WORKLOG.md` mới nhất cùng chỉ ra submission `VERIFYING` từ LOG-0059.
2. Ghi reviewer claim bằng LOG ID thực tế kế tiếp (`LOG-0060`). Xác định HEAD (`8bc8ac9a2161a7468b633c421185d039c97e5a68`), branch `main`, dirty inventory, source/build/test/package identity, application version (`1.5.1`) và accepted WP0.3 baseline. Đối chiếu submission với `source-freeze-log0059.json`.
3. Trước lệnh build/runtime/stateful đầu tiên, chụp đầy đủ `C:/Users/mon/AppData/Local/ThemisV2` và `C:/Users/mon/AppData/Local/JudgeDesk/JudgeDeskExecutor`: path/type/size/per-file SHA-256, aggregate, semantic state, processes, ports, owned roots và security state. Dùng root riêng có owner/containment đã kiểm chứng; snapshot helper phải lưu được cả mảng rỗng. Không đụng host data.
4. Freeze source/test/build/package hashes và mtimes trước probe, kiểm tra giữa review và sau cùng. Nếu source thay đổi, giữ evidence và vô hiệu hóa các kết quả phụ thuộc snapshot đó.

## Tái kiểm tra F1-F5 và 10 acceptance criteria

Review production call graph, feature/build graph, package output và process ownership trước khi chạy lệnh. Với mỗi claim, cần chỉ rõ production path, assertion executable và evidence:

- **F1 / (d), (e), (h), (i):** Kiểm tra `JUDGEDESK_TREE_GUARD_REQUIRED=1` đã bắt buộc trên Windows và macOS; thiếu/partial/forged generation hoặc sai OS parent PID bị từ chối với exit code 1 trước readiness. Thử probe gỡ bỏ biến môi trường hoặc cấp generation sai để xác nhận fail-closed. Kiểm tra `ExecutorClient` tự provision generation guard (`process-tree.lock`).
- **F2 / (a), (b), (j):** Xác minh production path chỉ resolve exact packaged executor sidecar từ metadata/thư mục tin cậy mà không fallback debug/PATH/in-process. Executor thiếu hoặc không tương thích phải trả lỗi `SECURE_RUNNER_UNAVAILABLE` trước khi nhận request.
- **F3 / (c), (g):** Kiểm tra protocol handling: truncated, malformed, oversized frame (>1 MiB cap) hoặc unknown response type phải lập tức terminate generation, hoàn tất pending requests với error, đóng admission vĩnh viễn và reap process tree.
- **F4 / (e)-(j):** Kiểm tra lifecycle production: 1 supervised client per generation, cancel thật sự chờ native process tree / Job Object drain xong mới trả về, parent EOF đóng stdin dẫn đến clean drain và thoát 0 sạch sẽ, updater Win32 `LockFileEx` exclusive lock contention chờ live executor nhả shared lock, và Node rollback client chạy trên cùng generation guard boundary.
- **F5 và project invariants:** Kiểm tra không còn `unwrap()` / `expect()` nào trong production runtime paths của `crates/judgedesk-core` và `native-executor`. Giữ nguyên 8-file version lockstep tại `1.5.1`, rational scoring, sandbox fail-closed, no compiler fallback, strict ESM.

## Lập bảng matrix và đánh giá kiểm thử

Lập matrix đầy đủ (a)-(j) đối chiếu với các test trong `crates/judgedesk-core/tests/executor_boundary_test.rs` (16 test cases):
- Chạy các target probes để kiểm tra F1-F5.
- Chạy các test suites:
  - `cargo test --manifest-path crates/judgedesk-core/Cargo.toml` (57 tests)
  - `cargo test --manifest-path native-executor/Cargo.toml` (61 tests)
  - `cargo clippy --manifest-path crates/judgedesk-core/Cargo.toml --all-targets -- -D warnings`
  - `cargo clippy --manifest-path native-executor/Cargo.toml --all-targets -- -D warnings`
  - `cargo fmt --manifest-path crates/judgedesk-core/Cargo.toml -- --check`
  - `cargo fmt --manifest-path native-executor/Cargo.toml -- --check`
  - `npm run check:fast`
  - `npm run release:check-version`
  - `npm run test:themis-parity`

## Host audit, verdict và bàn giao

Sau mỗi scenario kiểm tra cleanup. Chụp full after snapshot của cả hai AppData root (`ThemisV2` và `JudgeDeskExecutor`) sau 5–10 giây quan sát, thực hiện so sánh với before snapshot.

Ra đúng một verdict:
- **DONE:** nếu tất cả exit criteria WP0.4 và evidence đạt đầy đủ.
- **IN_PROGRESS:** nếu còn defect cần remediation.
- **BLOCKED:** chỉ khi prerequisite bên ngoài thực sự chặn.

Cập nhật `STATUS.md`, `wp0.4-executor-boundary.md`, `docs/adr/0001-rust-core-executor-boundary.md` và append entry vào `WORKLOG.md` với LOG ID thực tế. Không tự sửa code implementation để đổi verdict. Tạo prompt tiếp theo (remediation nếu IN_PROGRESS, hoặc WP0.5 implementation nếu DONE). Dừng mọi thao tác sau khi xuất báo cáo.
