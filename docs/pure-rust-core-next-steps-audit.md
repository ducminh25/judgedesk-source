# Pure Rust Core: đối chiếu hiện trạng và công việc tiếp theo

Ngày kiểm chứng: 2026-09-19. Checkout Windows: `d80f997` cùng các thay đổi chưa commit đang có. Đây là báo cáo khảo sát và kế hoạch, không phải xác nhận migration đã hoàn tất. Không sửa implementation trong lượt khảo sát này.

**Trạng thái phiên bản:** `v1.5.0` là bản đã phát hành và là baseline được kiểm chứng bên dưới. Các thay đổi hiện tại hướng tới `v1.6.0`; tám file version vẫn phải giữ đồng bộ ở `1.5.0` cho đến work package bump cuối cùng ngay trước release-candidate gate.

## 1. Kết luận

**Cần khép các khoảng trống về bảo mật, toolchain và API trước khi ưu tiên Universal PCH.** Stage 1 có self-test thật trên Windows nhưng chưa đạt tương thích sản phẩm hoặc đa nền tảng. Stage 3 đã có implementation một phần, không phải chưa bắt đầu. Stage 4 chưa đủ điều kiện cutover.

JudgeDesk vẫn là ứng dụng chấm thi offline: React quản lý workspace, cấu hình, bảng điểm, kết quả và export; Tauri quản lý cửa sổ, archive, lifecycle; Node là backend mặc định; native executor thực thi sandbox. Rust core mới cần thay thế toàn bộ trách nhiệm Node mà giữ nguyên hợp đồng với các lớp còn lại.

Đã đối chiếu AGENTS.md, guidelines.md, CONSTRAINTS.md, migration plan, index và các phần liên quan của PRD/TRD/APP_FLOW/BACKEND_SCHEMA/UI_UX_DESIGN, cùng code và tests của Rust core, backend Tauri, compiler Node, frontend judging/export/toolchains. Áp dụng các skill code-review-and-quality, security-and-hardening, debugging-and-error-recovery và computer-use. Có một lượt review độc lập chỉ đọc cho API/frontend parity.

## 2. Những phát hiện cần xử lý

Các số dòng dưới đây là của snapshot khảo sát, có thể thay đổi sau khi sửa code.

| Ưu tiên | Bằng chứng | Ảnh hưởng và yêu cầu |
|---|---|---|
| P0 | `crates/judgedesk-core/src/engine/runner.rs:240-314`: custom checker dùng `Command`, `spawn`, `wait_with_output`; timeout chỉ ngừng chờ channel | Checker chạy ngoài native sandbox; timeout không giết process tree. Chuyển checker qua executor với role, giới hạn và cancellation/drain thực. |
| P0 | `crates/judgedesk-core/src/toolchains/discovery.rs:402-453` | `none`, local path không hợp lệ hoặc managed thiếu có thể rơi xuống system executable; `local_auto` còn thử managed trước. Resolve phải giữ chính xác ý định nguồn, không fallback. |
| P0 | `crates/judgedesk-core/src/engine/compiler.rs:20,51,92,157`; `engine/session.rs:289` | Compiler của batch gọi PATH, không nhận lựa chọn toolchain, compile profile hay chứng nhận. Không có watchdog/giới hạn output. Port pipeline compiler được pin và bảo vệ trước tối ưu PCH. |
| P0 | `crates/judgedesk-core/src/server/mod.rs:110-114,1334-1348` | CORS cho mọi origin/method/header; đường dẫn folder picker được nội suy trực tiếp vào PowerShell. Phục hồi origin boundary, validation và truyền tham số không qua nối script. Chưa chạy payload khai thác. |
| P0 | `src-tauri/src/backend.rs:252-318` | Dù mặc định Node, lỗi tìm/spawn sidecar tự fallback sang Rust chưa đủ chức năng. Giữ Rust opt-in rõ ràng đến khi đạt cutover; lỗi Node phải có chẩn đoán đúng. |
| P1 | `crates/judgedesk-core/src/server/mod.rs:71-81,1130-1199,1272-1321` | Toolchain store có installed giả định, preference chỉ RAM, policy echo, certification dữ liệu cố định, install/uninstall chỉ sửa HashSet. Cần persistence/receipt/signature/download/extract/certification thực và khóa mutation khi chấm. |
| P1 | `engine/compiler.rs:86-123`; `engine/runner.rs:70-72` | Java/Scratch không có compile/runtime adapter trong batch. Python source bị coi như binary và copy thành `prog.exe` trên Windows. Self-test sáu ngôn ngữ chưa chứng minh chấm sáu ngôn ngữ. |
| P1 | `server/mod.rs:388-398`; `engine/session.rs:161-219`; `src/features/judging/useJudgeSession.ts:89-96` | Rust bỏ `problemConfigs` của request và tự đọc một phần config/default. Phải port đúng precedence stored config/request config/default của Node, normalize flags, giới hạn, checker, I/O và scoring. Không đơn giản ưu tiên request hơn file. |
| P1 | `server/mod.rs:405,439-441`; `engine/runner.rs:131` | Cancel dùng AtomicBool chung, reset khi có request mới, bỏ jobId; active runs cục bộ. Thiếu admission gate và cancel/drain của run đang chạy; disconnect, cancel-before-register, concurrent requests cần test. |
| P1 | `engine/session.rs:318-365` | `isInteractive` chỉ ảnh hưởng discovery; execution vẫn gọi runner thường. Chưa có pipeline hai tiến trình submission/interactor với lifecycle và verdict riêng. |
| P1 | `engine/session.rs:97-99`; `src/features/export/score-workbook.ts:180-183` | Metadata Rust thiếu `toolchains.python` mà exporter truy cập trực tiếp. Cần contract test Rust metadata qua exporter hiện tại; chưa tái hiện lỗi Excel bằng GUI. |
| P1 | `server/mod.rs:1324-1328,1427-1455` | OSD chỉ trả trạng thái cố định và stream kết nối, chưa có watcher/queue/events thực. Không đánh dấu tương thích OSD từ HTTP 200. |
| P1 | `rational.rs:112-145,172-193`; `engine/session.rs:392-398` | Parse fraction/decimal qua f64, multiplier qua xấp xỉ, phép toán i64 dùng saturating. Cần kiểm tra precision/overflow và port parser/arithmetic giữ phân số chính xác. Phân biệt chuyển số để hiển thị cuối cùng với tính điểm trung gian. |
| P2 | `engine/runner.rs:14-16`; `scripts/check-quality-gate.js:36-37,126-127` | Preview cắt chuỗi theo byte có thể panic tại ký tự UTF-8; gate hiện chủ yếu quét TS, không bao phủ Rust core. Bổ sung kiểm thử Unicode và gate Rust, không coi check:fast xanh là chứng minh core an toàn. |

`ResourceOnly` trong diagnostics Pascal/Java/Scratch phải được rà soát theo chính sách riêng. Job Object/Low Integrity không tự chứng minh zero-network hoặc filesystem isolation; không nhân rộng nhánh này sang bài nộp chỉ để đạt badge xanh.

## 3. Kết quả đã chạy

### Windows

| Kiểm tra | Kết quả |
|---|---|
| `npm run check:fast` | PASS: types và quality gate hiện hành |
| `npm run release:check-version` | PASS: 1.5.0 — đúng baseline đã phát hành; chưa đến bước bump đồng bộ lên target 1.6.0 |
| `npm run check:full` chạy cuối cùng, tuần tự | PASS, exit 0: types/quality, build executor, 532 pass + 10 skip, version lockstep; test suite 64.4 giây |
| `node scripts/run-all-tests.js --test-timeout=30000` | 542 tests: 532 pass, 10 skip có sẵn, 0 fail/cancel; 81.9 giây |
| `cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml -- --test-threads=1` | 36 pass, gồm sáu ngôn ngữ trong một diagnostic test |
| `cargo test --locked --manifest-path native-executor/Cargo.toml -- --test-threads=1` chạy riêng | 54 pass (51 library + 3 binary) |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 14 pass, 3 ignored có sẵn |
| `JUDGEDESK_PURE_RUST_CORE=1; npm run test:desktop` | Build và khởi động thành công; log xác nhận embedded Rust |
| Computer Use Windows | Quan sát main window, F6, sáu profile; nhấn C++ Self-Test: Operating Normally, compile 2926ms, run 60ms, memory 1976 KB |

Lượt Node đầu bị dừng sau khi tiến trình đứng lâu trong compiler test; lượt chạy lại có timeout hữu hạn pass. Lượt executor/desktop ban đầu chạy cùng các kiểm thử dùng chung executor cache gặp `os error 32`. Sau khi dừng các tiến trình kiểm thử và chạy tuần tự: executor pass, desktop `secureRunner.ready=true`, mode `windows-lpac-job`. Không quy lỗi này thành regression sản phẩm khi chưa có reproduction độc lập.

Không diễn giải 10 skipped hoặc 3 ignored thành đã kiểm chứng. `git diff --check` còn báo blank line cuối file ở bốn file đã thay đổi trước lượt khảo sát: UI_UX_DESIGN.md, startup_guard.rs, availability.ts, editor-state.test.ts; không sửa các thay đổi có sẵn này.

### macOS qua SSH/Tailscale

- Host alias `judgedesk-mac`: Darwin ARM64, macOS 26.6.2; Cargo 1.97.1, Node 24.19.0.
- Hai checkout có thay đổi riêng: không ghi đè chúng. Chuyển source core/executor hiện tại cùng lockfiles, rust-toolchain và judgers vào `/tmp/judgedesk-migration-audit.nEpP9q`.
- SHA-256 archive giống nhau ở hai máy: `df45894637eaea9b972faf13261ade25bc31752b14124c19163756a2c570ca1d`.
- Rust core: **35 pass, 1 fail**. Diagnostic test dừng ở C++, lỗi compile `fatal error: 'iostream' file not found`. Các ngôn ngữ phía sau chưa chạy trong test này, không được coi là pass.
- Native executor: **76 pass** (73 library + 3 binary).
- Host smoke bằng `/usr/bin/clang++` và `xcrun clang++` compile/run ra `42` thành công. Preference C++ trên Mac đang là `local_path` tới Xcode `clang`, không phải `clang++`. Gọi riêng đường dẫn đó trên probe khác cho lỗi linker C++ standard library. Đây là bằng chứng cần kiểm tra driver identity/SDK/environment và preference compatibility; chưa kết luận toàn bộ root cause của lỗi header.
- SSH chưa kiểm chứng visual WKWebView, resize, native file dialog hay packaged app/update. Chưa chạy Tauri test/build trên Mac trong lượt này.

Log cục bộ nằm trong `%TEMP%`, tiền tố `judgedesk-migration-audit-`: `node-bounded.log`, `rust.log`, `executor-isolated.log`, `tauri.log`, `desktop-isolated.log`, `mac-core.log`, `mac-executor.log`, `full-final.log`.

## 4. Sửa lại các giả định trong master plan

1. Stage 1 không nên ghi “100% Completed & Verified” cho toàn sản phẩm/đa nền tảng; cần tách discovery, persistence, readiness, self-test và batch execution.
2. Stage 2: baseline submission là **15,000ms và 32 MiB** (`server/judge/compiler.ts:65-66`), custom checker timeout **60,000ms** (`checker-compiler.ts:24`); plan ghi 10,000ms/50MB sẽ làm đổi hành vi.
3. Không port watchdog chỉ bằng `tokio::time::timeout(Command)`. Deadline phải dẫn tới kill/drain cả cây tiến trình, giới hạn stdout/stderr/disk và RAII cleanup; compiler vẫn đi qua boundary phù hợp.
4. API thật frontend dùng `/api/batch-judge` và `/api/batch-judge/cancel`, stream JSON theo dòng. Plan ghi `/api/judge/session` và docs có ví dụ SSE/event names khác code. Lập contract từ Node + shared types + consumer thật trước khi port.
5. Không chạy dual-backend verdict/resource benchmark đồng thời trên cache/workspace chung. Tách dữ liệu và executor root; chạy benchmark tuần tự để giảm nhiễu TLE/MLE.
6. PCH fallback chỉ bỏ tăng tốc, vẫn dùng chính compiler/profile đã chọn. Cache fingerprint phải bao gồm flags, compiler identity/version, headers/SDK và platform; có hit/miss chứng minh thực, không chỉ file `.gch` tồn tại.
7. Các số RAM/boot/compile trong plan là mục tiêu hoặc số lịch sử, chưa có benchmark tái lập trong lượt này. Native compilation không đồng nghĩa không thể reverse engineer.

## 5. Thứ tự triển khai đề xuất

### Bước A — cố định contract và chặn đường chạy không an toàn

- Viết failing tests cho fallback nguồn/backend, origin boundary, folder picker quoting, checker sandbox/timeout và path containment.
- Giữ Node default; yêu cầu opt-in rõ ràng cho Rust, không tự fallback khi sidecar lỗi.
- Lập inventory mỗi endpoint: method, payload, success/error/status, state mutation, persistence, frontend consumer, streaming order.
- Chuyển các API chưa thực hiện sang lỗi unsupported rõ ràng trong nhánh thử nghiệm cho đến khi hoàn thiện; không trả thành công giả.
- Thêm Rust core vào kiểm tra types/contracts, fmt, clippy và test gate. Đọc skill TDD/doubt-driven-development/constraint-driven-development trước implementation tương ứng.

**Đạt khi:** không có đường thực thi checker ngoài sandbox; không fallback compiler; negative tests đúng; Node behavior còn nguyên.

### Bước B — toolchain và compiler dùng chung cho diagnose và batch

- Port preference document/revisions, atomic storage, managed receipts, source resolution, runtime executable và certification theo Node.
- Snapshot toolchain tại đầu phiên; khóa mutation; dùng cùng pipeline thật cho self-test và chấm.
- Compiler watchdog, output limits, bounded diagnostics, cancel/drain, cleanup; theo giới hạn hiện hành từng role/language.
- Sửa Apple Clang resolution/driver/SDK có reproduction trên Mac; bảo toàn managed Python semantics và chính sách ResourceOnly.
- Đủ C++, C, Python, Pascal, Java và Scratch trong batch, không chỉ diagnostics.

**Đạt khi:** mỗi nguồn `none/managed/local_path/local_auto` có success/failure tests; invalid path không fallback; 6-language smoke chạy trên Windows và macOS hoặc trả lỗi đúng chính sách.

### Bước C — session, configuration, scoring, checker/interactor

- Port normalization và precedence config, compile profile, stdio/file I/O; preserve Reload selections.
- Job admission, cancellation tombstones, native active-run tracking và drain, disconnect/shutdown semantics.
- Standard/custom checker và interactive runner; không tự chọn checker khác khi checker đã chọn compile fail.
- Rational parser/arithmetic và overflow tests; verdict/error/details/metadata đầy đủ.
- Test metadata bằng exporter, archive round-trip và rejudge/delete workflows.

**Đạt khi:** corpus Node/Rust khớp verdict, rational points, ranking, selected targets, error semantics; không bỏ qua mismatches.

### Bước D — PCH và prewarm sau correctness

- Đọc performance-optimization; đo baseline cold/warm và hit/miss trước chỉnh.
- Port Universal PCH với single-flight, atomic publish, fingerprint, flags compatibility, GCC/Clang và macOS headers.
- Kiểm tra compiler path có space/Unicode, cache hỏng, flags đổi, startup/cancel race; compiler không đổi khi PCH fail.
- Đo compile latency và footprint trên mỗi OS khi không có bộ test khác tranh tài nguyên.

### Bước E — desktop parity và cutover

- Hoàn thiện OSD watcher/queue, toolchain install/uninstall/rescan/certification, export, lifecycle và packaging.
- Chạy ma trận bên dưới với Node và Rust, ghi test data/hash, runtime, kết quả, log và evidence hình ảnh.
- macOS: SSH chạy build/core/executor/security/lifecycle/packaged checks; bổ sung xác nhận GUI trên phiên Mac thực cho WKWebView/native dialogs.
- Chỉ cutover sau khi các gate và corpus parity đều đạt; giữ rollback có chủ đích, không phát hành trong lượt khảo sát này.

## 6. Ma trận UI/UX cần nghiệm thu

Tất cả hàng dưới đây còn cần full end-to-end, ngoại trừ startup/F6/C++ self-test Windows smoke đã ghi ở mục 3.

| Khu vực | Ca kiểm chứng |
|---|---|
| Startup/lifecycle | Cold/warm boot, single instance, sidecar lỗi, unavailable runner, close/crash, shutdown trong lúc chấm; không orphan |
| Workspace | Folder empty/missing/Unicode/spaces; 18×5 và 72×20; F2/F3/F5; giữ checked/unchecked và điểm cũ khi Reload |
| Scoreboard | Resize nhiều kích thước, scrollbar/sticky headers, sort 3 trạng thái, ties, unjudged, keyboard, context menu, double-click details; không jitter |
| Problem config | Load/save/reopen; total và testcase fractions; groups/dependencies; 8–1024MB; stdio/file; compiler preset; invalid flags; checker/interactor |
| Toolchains | Sáu ngôn ngữ × bốn nguồn; thiếu/hỏng/path sai; persistence qua restart; rescan; self-test metrics/errors; mutations blocked khi chấm |
| Judging | AC/WA/PE/PARTIAL/CE/RE/TLE/MLE/OLE/JE; language adapters; compile timeout/oversize; detail/log/Unicode; rejudge/delete selected |
| Cancellation | Cancel khi compile/staging/test/checker/interactive; disconnect; new job sau cancel; double click; restart sau crash |
| Archive/export | New/open/save/save-as/dirty prompt; portable archive, overwrite safety; Excel đúng order/rank/metadata; viewer lỗi |
| OSD | Start/stop thực, file arrival/debounce/queue, duplicates/malformed filenames, batch conflict, events reconnect |
| Presentation | VI/EN, light/dark, focus/tab/Escape, shortcut conflicts, text overflow, empty/loading/error states, Help |
| Release UI | Update check/errors/cancel, staged installer handoff, Core/Full semantics; installation kiểm tra riêng trên build đóng gói |

Không dùng corpus độc hại để chạy qua Rust core trước khi các boundary P0 được khép. Native-executor unit tests xanh không chứng minh mọi caller đã sử dụng executor đúng.
