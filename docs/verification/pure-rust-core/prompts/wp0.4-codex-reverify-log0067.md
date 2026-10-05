# Prompt — Codex mới xác minh độc lập WP0.4 sau LOG-0067

Bạn là verifier độc lập trong một cuộc hội thoại Codex mới. Mon yêu cầu Codex remediate WP0.4 và giao phiên mới quyết định có đủ điều kiện chuyển từ VERIFYING sang DONE hay không. Đây là review, không phải lượt tiếp tục implement.

## Ranh giới công việc

- Làm trong saved dirty checkout D:/Minh/Code/judgedesk. Bảo toàn mọi thay đổi, log và artifact hiện có. Không tạo worktree; không reset, stash, clean, commit, push, bump version, đóng G0, bắt đầu WP0.5 hoặc tự sửa implementation.
- Đọc AGENTS.md, guidelines.md, CONSTRAINTS.md, docs/pure-rust-core-start-here.md, STATUS, WORKLOG, detailed implementation plan, efficient-execution protocol, ADR 0001, toàn bộ report wp0.4-executor-boundary.md, các prompt WP0.4 liên quan và accepted WP0.3 closure.
- Đọc đầy đủ Section 16 của report và artifacts tại docs/verification/pure-rust-core/artifacts/wp0.4/remediation-log0067-codex-20260927/, đặc biệt source-freeze-log0067.json, source-freeze-validation-log0067.json, revalidation-wp03-log0067.json, executable-provenance-log0067.json, các test/gate logs, AppData delta và platform-status records. Đối chiếu lịch sử LOG-0066; không coi submitter claims là reviewer evidence.
- Chỉ review candidate nếu STATUS summary, WP0.4 ledger row, handoff YAML, WORKLOG, report và ADR đều đang chỉ cùng LOG-0067 VERIFYING submission. Nếu còn mâu thuẫn hoặc freeze sai, dừng trước mọi stateful/runtime probe; ghi chính xác lỗi intake và verdict IN_PROGRESS.

## Source và executable intake

1. Ghi branch, HEAD, dirty inventory, version lockstep và môi trường. Giữ nguyên dirty checkout.
2. Tự tính lại SHA-256, byte size, UTC mtime ticks của cả 69 record trong source-freeze-log0067.json trước và sau review. Xác minh đủ 30 hash trong accepted WP0.3 baseline. Theo dõi các source/build/test/package inputs trong lúc review; thay đổi làm candidate freeze stale thì dừng acceptance và ghi lại.
3. Xác minh src-tauri/binaries/judgedesk-executor-x86_64-pc-windows-msvc.exe có đúng hash 65033C68C09136D2501E783E09EBCFF6A5C26FDB06A4C71977637EDA6B279D48, 934,400 bytes. Đối chiếu với native-executor/target/x86_64-pc-windows-msvc/release/judgedesk-native-executor.exe, recipe npm run build:executor, provenance, và source inventory hiện có. File cũ native-executor/target/release/judgedesk-native-executor.exe khác hash/kích thước và không phải ứng viên được chọn.
4. Kiểm tra helper Rust phân giải đúng staged path, fail-closed nếu hash/path sai, không fallback target/debug; kiểm tra Node rollback tự chọn staged path khi JUDGEDESK_EXECUTOR_PATH đã unset. Không dùng path override để tuyên bố đã kiểm tra packaged resolution.

## Probe WP0.4 bắt buộc

- Trước test, lấy snapshot AppData có owner marker do reviewer tạo và kiểm tra hai root C:\Users\mon\AppData\Local\ThemisV2 cùng C:\Users\mon\AppData\Local\JudgeDesk\JudgeDeskExecutor. Giữ nguyên các delta lịch sử ghi trong LOG-0066 và appdata-delta-log0066-to-log0067.json: 14 content-addressed .exe additions, thay đổi startup probe.exe/probe.stderr. Không xóa hoặc sửa lại baseline host.
- Dùng owned temp roots và kiểm tra marker, canonical containment, reparse points, tiến trình/port tồn dư. Chạy delayed cleanup observation. Không dùng thư mục full-check-final/before làm baseline: snapshot-attempt.json đánh dấu nó không hoàn chỉnh. Cặp before/after hoàn chỉnh hiện có chỉ bao phủ lần check-full-attempt2; reviewer phải tạo cặp mới cho các probe của chính mình. Temp root implementation-owned `C:\Users\mon\AppData\Local\Temp\judgedesk-wp04-log0067-23e198a599724a85b21316902d5fc9fb` còn tồn tại với `.judgedesk-owned-root.json`; phiên remediation xác nhận marker/path, không có reparse point hay process dùng nó, nhưng lệnh dọn đệ quy bị policy chặn. Ghi nhận nó là root có sẵn trước review, đừng coi là root reviewer tạo hoặc xóa nó.
- Chạy trực tiếp candidate đã xác minh. Gửi health preflight, rồi gửi riêng từng framed request: JSON hỏng { và một request type không biết; xếp một health request sau mỗi request lỗi. Với cả hai, xác nhận protocol error, EOF (không có health response tiếp theo), nonzero exit và process đã thoát trước khi khởi động replacement. Xác nhận replacement nắm được generation guard và trả health ready=true. Ghi exact binary hash, request bytes, stdout/stderr, exit code, cleanup.
- Đọc production path, không chỉ test: terminal failure phải đóng admission, drain accepted/active jobs, giữ generation guard tới hết drain, rồi mới thoát. Rà từng tiêu chí (a)–(j) trong plan/ADR và chứng minh bằng source trace cộng probe/test phù hợp; đặc biệt cancellation reservation/native drain, parent EOF, updater exclusion và Node rollback.
- Rà các nhánh CLI `--test-*` trong packaged executor: chúng được dispatch trước `run()`/tree-guard và một số test dùng chính binary này làm sandbox payload. Trace riêng cách gọi trực tiếp trên host và cách chạy bên trong sandbox; xác định artifact phân phối có phơi ra thao tác host-side không được bảo vệ hay các nhánh chỉ là payload kiểm tra đã bị sandbox giới hạn. Đối chiếu việc bỏ `JUDGEDESK_EXECUTOR_TOKEN` với caller Node rollback và Rust; không suy diễn token env là authentication nếu không có bằng chứng. Nếu probe, chỉ ghi/đọc trong verifier-owned temp root và nêu rõ kết quả trong verdict.
- Rà F5 trên code production (tách test-only unwrap()/expect()), và chạy poisoned-mutex regression. Dùng executor_boundary_test cùng test native executor như chứng cứ bổ sung, không dùng green aggregate thay cho kiểm tra hành vi.

## Gates và giới hạn nền tảng

Chạy các gate phù hợp theo AGENTS.md sau khi intake hợp lệ: npm run check:fast, npm run check:full, cargo test --locked --manifest-path native-executor/Cargo.toml, focused executor_boundary_test, Windows all-target Clippy (-D warnings), cargo fmt -- --check cho hai crates, và npm run release:check-version. Ghi nguyên exit code và toàn bộ log. Nếu c_mle_stdio timeout như ở check-full-final.log, giữ failure rõ ràng; retry có thể cung cấp thêm dữ liệu nhưng không xóa lần thất bại. npm run test:corpus lần submitter chạy riêng pass 14/14 test checks và 25 fixture IDs, còn check-full-final-rerun.log là lần full gate sau đó pass.

cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml hiện có failure trong toolchain_diagnose_test: isolated test root không có managed Scratch runtime. Không đổi test, skip, hay chuyển sang AppData thật để làm nó xanh. Xác định test đó có phải WP0.4 exit requirement hay không và ghi chính xác trạng thái; không gọi nó PASS.

Mac ARM64 all-target cargo check/Clippy đã pass trong submission, nhưng macOS executor, Seatbelt, guardian, cancellation, updater và packaged runtime đều là NOT_RUN. SSH tới Tailscale judgedesk-mac (100.78.209.71:22) trước đây timeout; thử kết nối lại nếu môi trường phiên mới cho phép. Cross-target compile hoặc Windows runtime không thay thế Mac runtime. Nếu tiêu chí WP0.4 yêu cầu Mac runtime, thiếu run thì không được DONE.

## Verdict và cập nhật hồ sơ

Đưa ra đúng một verdict có bằng chứng: DONE chỉ khi mọi exit criteria và platform-required evidence được độc lập chứng minh; IN_PROGRESS nếu còn defect nội bộ có thể xử lý hoặc thiếu evidence bắt buộc; BLOCKED chỉ khi một prerequisite bên ngoài thực sự ngăn cản công việc. Không dùng conditional approval, không tự remediate trong review session.

Ghi reviewer-owned logs, snapshot comparison và source-freeze before/after. Append-only cập nhật STATUS, report, ADR và WORKLOG cho đúng verdict. Nếu IN_PROGRESS, tạo prompt remediation tiếng Anh cho Antigravity và prompt reverify tiếng Việt cho Codex mới. Nếu DONE, chỉ cập nhật WP0.4 theo evidence được chấp nhận; G0/WP0.5 vẫn cần handoff riêng. Dừng sau khi lưu verdict và handoff.
