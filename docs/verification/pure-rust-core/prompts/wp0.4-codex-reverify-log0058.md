# Prompt — Codex mới: review độc lập WP0.4 sau LOG-0058

Bạn là reviewer/verifier độc lập WP0.4 của JudgeDesk Pure Rust Core. Chỉ bắt đầu khi Antigravity đã xử lý LOG-0058, cập nhật STATUS/report/WORKLOG và tạo submission mới ở trạng thái VERIFYING. Làm trên saved dirty checkout D:/Minh/Code/judgedesk; không tạo worktree, reset/stash/clean, commit/push, sửa implementation để tự nghiệm thu, đổi version, đóng G0 hoặc bắt đầu WP0.5.

## Phạm vi và nguồn chuẩn

Đọc AGENTS.md, guidelines.md, CONSTRAINTS.md, docs/pure-rust-core-start-here.md, STATUS.md, WORKLOG.md, detailed implementation plan, efficient-execution protocol, ADR 0001, WP0.4 report và prompt triển khai WP0.4. Đọc đầy đủ LOG-0058 ở report Section 7 và bằng chứng bất biến tại:

docs/verification/pure-rust-core/artifacts/wp0.4/independent-review-log0058-codex-20260926/

Áp dụng review/quality, doubt-driven, security/hardening, constraint-driven và debugging skills phù hợp. LOG-0058 kết luận IN_PROGRESS. Nó ghi nhận F1-F5 và một reviewer-owned root còn sót lại vì hai lệnh xóa đệ quy bị command approval policy từ chối. Giữ nguyên evidence cũ. Không dùng owned-runtime cũ làm runtime/build root; xác minh trạng thái của nó và ghi nhận trung thực.

## Điều kiện intake và đóng băng nguồn

1. Xác nhận ledger và WORKLOG mới nhất cùng chỉ ra một submission VERIFYING. Nếu không, ghi đúng trạng thái intake và dừng acceptance.
2. Ghi reviewer claim bằng LOG ID thực tế kế tiếp. Xác định HEAD, branch, dirty inventory, source/build/test/package identity, application version và accepted WP0.3 baseline. Đối chiếu submission mới với baseline WP0.3 đã được chấp nhận; không coi HEAD hay implementer report là bằng chứng.
3. Trước lệnh build/runtime/stateful đầu tiên, chụp đầy đủ C:/Users/mon/AppData/Local/ThemisV2 và C:/Users/mon/AppData/Local/JudgeDesk/JudgeDeskExecutor: path/type/size/per-file SHA-256, aggregate, semantic state, processes, ports, owned roots và security state. Dùng root riêng có owner/containment đã kiểm chứng; snapshot helper phải lưu được cả mảng rỗng. Không đụng host data.
4. Freeze source/test/build/package hashes và mtimes trước probe, kiểm tra giữa review và sau cùng. Nếu source thay đổi, giữ evidence và vô hiệu hóa các kết quả phụ thuộc snapshot đó.

## Tái kiểm tra F1-F5 và 10 acceptance criteria

Review production call graph, feature/build graph, package output và process ownership trước khi chạy lệnh. Với mỗi claim, cần chỉ rõ production path, assertion executable và evidence; test name, mock, serialization-only check hoặc ADR text không đủ.

- **F1 / (d), (e), (h), (i):** bắt buộc parent identity được xác thực bằng OS trên Windows và macOS; thiếu/partial/forged/stale/foreign parent hoặc generation phải bị từ chối trước readiness. Environment PID/UUID đơn thuần không phải authentication. Chứng minh đúng một owner/client cho mỗi generation; EOF phải dừng cây process, port và owned root; updater exclusive handoff phải chờ đúng live generation. Thực hiện live test theo platform khả dụng và đánh dấu NOT_RUN cho platform không chạy.
- **F2 / (a), (b), (j):** xác minh release feature graph không thể gọi Platform in-process qua feature/helper/fallback; resolver chỉ chọn đúng artifact đóng gói từ metadata tin cậy. Thiếu, incompatible, non-ready hoặc thiếu isolation capabilities phải trả unavailable trước admission. Thực thi Node rollback client thật trên cùng compatible packaged boundary và generation ownership.
- **F3 / (c), (g):** kiểm tra Node/Rust framed-v1 bằng byte-level execution: 4-byte LE, length khác 0, cap 1 MiB, correlation, malformed/truncated/oversized/unknown type và ID sai. Server reply hỏng phải đóng admission, hoàn tất pending request với lỗi, đánh dấu generation terminal, drain/reap process tree; không replace owner khi process cũ chưa được chứng minh đã chết.
- **F4 / (e)-(j):** chứng minh lifecycle trong production path, không suy từ unit lock fixture. Thực hiện concurrent startup, accepted reservation và active-run cancellation; cancel/completion chỉ sau native drain thật. Xác minh EOF, updater handoff, package ownership và rollback trên cùng generation. Không đẩy exit criterion WP0.4 sang WP1.1/WP1.4/WP1.6/WP4.3 hoặc Phases 3–5.
- **F5 và project invariants:** runtime server/executor không dùng unwrap/expect; startup/protocol/run lỗi truyền thành unavailable/error rõ ràng thay vì panic. Giữ rational scoring, sandbox fail-closed, no compiler fallback, strict ESM, đủ tests, version lockstep 1.5.1, không hạ gate hoặc skip test.

Lập matrix cho đủ (a)-(j), ghi source, production execution, assertion, evidence, Windows/macOS scope và PASS/FAIL/PARTIAL/NOT_RUN. Probe chọn lọc để bác bỏ claim trước. Dừng các gate tổng hợp không liên quan ngay khi có defect đủ để kết luận IN_PROGRESS. Chỉ khi tất cả probe chấp nhận được mới chạy đúng một lần thành công npm run check:full trên final frozen source, cùng locked Rust tests, fmt, all-target clippy -D warnings và các security/platform checks còn thiếu.

## Host audit, verdict và bàn giao

Sau mỗi scenario kiểm tra cleanup; serialize các suite dùng chung host state. Quan sát 5–10 giây, chụp full after snapshot của cả hai AppData root cùng reviewer-owned roots/processes/ports/security state và giữ raw deltas. Không tuyên bố host-temp equality nếu helper không lưu được empty set. Windows không thay macOS; source parity không thay live platform test.

Ra đúng một verdict: DONE nếu WP0.4 exit criteria và evidence đầy đủ; IN_PROGRESS nếu còn defect trong repo; BLOCKED chỉ khi prerequisite bên ngoài thực sự chặn. Cập nhật STATUS, report, ADR status và append WORKLOG bằng LOG ID thực tế; giữ nguyên historical logs. Không tự sửa implementation để đổi verdict. Tạo prompt remediation và prompt re-verification mới nếu IN_PROGRESS; nếu DONE thì tạo prompt WP0.5 phù hợp. Không gửi tin sang conversation khác. Dừng sau khi hoàn tất verdict, ledger và prompts tiếp theo.
