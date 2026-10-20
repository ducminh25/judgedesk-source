# Pure-Rust Core (`crates/judgedesk-core`) — Tiến độ Giai đoạn A (2026-10-14)

> **Phiên bản baseline:** Application source `1.5.5` (8-file version lockstep verified via `npm run release:check-version`), crate `crates/judgedesk-core/Cargo.toml` giữ ở `1.5.1`, mục tiêu cutover `1.6.0` (`WP10.3`).  
> **Phạm vi Giai đoạn A:** Core Judging, Toolchain & Security Foundation (Bước 1–5 trong working tree).  
> **Phạm vi thẩm quyền (Governance Boundary):** Báo cáo này ghi nhận tiến độ triển khai và bằng chứng test thực thi cho Bước 1–5 trong working tree; **không tự động thay thế bước nghiệm thu độc lập (`DONE`)** đối với `N0` hay các gói `WP*` trên sổ cái chính thức [`docs/verification/pure-rust-core/STATUS.md`](../verification/pure-rust-core/STATUS.md).  
> **Nguyên tắc thực thi:** TDD (`RED` → `GREEN`) bắt buộc trước mỗi thay đổi logic, tự phản biện / subagent review độc lập theo từng bước, không thêm dependency ngoài `Cargo.lock` (`--locked`), báo cáo trung thực trạng thái từng gate (bao gồm `judgedesk-mac`).

---

## Bảng tổng hợp trạng thái 5 bước (Giai đoạn A) & Ánh xạ `WP*`

| Bước | Hạng mục | Ánh xạ gói `WP*` (DAG) | Trạng thái Windows (`x64`) | Trạng thái macOS (`judgedesk-mac`) | Ghi chú thực thi & phạm vi |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Bước 1** | Tách cấu trúc `server` & Khóa biên bảo mật hệ thống (`OwnedWorkspace`, `NativeDirectoryPicker`, `NativeWorkbookOpener`, 501/409 stubs) | `WP0.7`, `WP1.2`, `WP1.3`, `WP1.5`, `WP1.6` | **PASS (`GREEN`)** | **PASS (`GREEN`)** | `step1_security_boundary_test` (4/4), `toolchain_diagnose_test` (8/8), `clippy -D warnings` sạch |
| **Bước 2** | Toolchain Store, Persistence, Managed Receipts & Helper `quick_verified_direct` / `freeze_required` | Một phần `WP2.2`, `WP2.3`, `WP2.6`, `WP2.7`, `WP3.3` | **PASS (`GREEN`)** | **PASS (`GREEN`)** | `step2_toolchains_policy_test` (5/5), `server_test` (11/11); phần `rescan`, install/uninstall/certify thật và nối `FreezeRequired` vào resolver sản phẩm thuộc pha tiếp theo |
| **Bước 3** | Sandboxed Compiler Service & Bộ điều hợp Batch 6 ngôn ngữ qua `ExecutorClient` | Một phần `WP3.1`, `WP3.2` | **PASS (`GREEN`)** | **PASS (`GREEN`)** | `step3_sandboxed_compiler_runner_test` (4/4), 6 ngôn ngữ compile + run trong sandbox; còn cần nối `ProblemCompileConfig` (`shared/compile-config.ts`) |
| **Bước 4** | Session Lifecycle, Problem Config Normalization, Job Admission, Cancellation & Drain | Một phần `WP4.1`–`WP4.5` | **PASS (`GREEN`)** | **PASS (`GREEN`)** | `step4_lifecycle_config_cancel_test` (3/3), instant cancel <1.5s, 4-phase drain; còn cần đóng nốt cancel ownership theo từng `jobId` và header/thứ tự stream |
| **Bước 5** | `BigUint` Rational Primitive, Sandboxed Custom Checkers & Interactive Runner | Một phần `WP1.4`, `WP5.1`, `WP5.3`, `WP5.4` | **PASS (`GREEN`)** | **PASS (`GREEN`)** | `step5_rational_checker_interactive_test` (3/3), `rational_test` (5/5), `scoring_test` (7/7); còn cần đóng nốt pipeline rational xuyên suốt (bỏ `f64` multiplier), `totalScore` scaling và `JE` zero-score |

---

## 0. Kiểm tra nền tảng trước khi bắt đầu (`Pre-flight Check`)

- `git status --short`: Cây làm việc giữ nguyên các thay đổi từ đợt Hardening `v1.5.5` vừa nghiệm thu.
- `npm run release:check-version`: **PASS** (`Release version verified: 1.5.5`).

---

## Bước 1 — Tách cấu trúc `crates/judgedesk-core/src/server` & Khóa biên bảo mật hệ thống

### 1.1. Vòng lặp TDD (`RED` → `GREEN`)
- **Test file mới:** `crates/judgedesk-core/tests/step1_security_boundary_test.rs` (4 kịch bản kiểm thử):
  1. `test_step1_auth_middleware_enforces_session_host_and_origin`: Kiểm chứng `DesktopApiBoundary` (session token `X-JudgeDesk-Session`, `Host` loopback IPv4/IPv6/`localhost`, `Origin` desktop allowlist `tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`, loopback origins).
  2. `test_step1_owned_workspace_and_hostile_path_containment`: Kiểm chứng `OwnedWorkspace` và `ensure_safe_contained_path` chặn traversal (`..`, `.`), Windows Alternate Data Streams (`:`), symlink và Windows directory junction (`FILE_ATTRIBUTE_REPARSE_POINT = 0x0400`), đồng thời đảm bảo `cleanup()` không xóa xuyên qua junction sang thư mục ngoài.
  3. `test_step1_directory_picker_and_workbook_opener_reject_hostile_paths_and_prevent_shell_interpolation`: Kiểm chứng `NativeDirectoryPicker` và `NativeWorkbookOpener` từ chối đường dẫn không tồn tại / traversal / ADS / symlink / sai đuôi `.xlsx` / nằm ngoài vùng cho phép, và khi tên thư mục chứa metacharacter độc hại (`O'Reilly $( calc ) & echo pwn`) thì truyền qua biến môi trường (`THEMIS_DEFAULT_PATH` trên Windows) hoặc `argv` rời rạc (`osascript -- <dir>` trên macOS, `excel.exe /t` hoặc `explorer.exe` trên Windows, tuyệt đối không nội suy vào chuỗi PowerShell/AppleScript và không dùng `cmd /C start`).
  4. `test_step1_unimplemented_phase_b_routes_return_truthful_501`: Kiểm chứng `/api/osd/{status,start,stop,events}` trả về `501 Not Implemented` (`OSD_NOT_IMPLEMENTED`) và `/api/toolchains/prewarm` trả về `501 Not Implemented` (`PREWARM_NOT_IMPLEMENTED`).

### 1.2. Thay đổi kiến trúc & bảo mật đã thực hiện
- **Tách `crates/judgedesk-core/src/server/mod.rs` (>2.100 dòng → 156 dòng)** thành các module:
  - `server/auth.rs`: Giữ nguyên 100% lớp bảo vệ `DesktopApiBoundary` (`X-JudgeDesk-Session`, `Host`, `Origin`).
  - `server/dto.rs`: Tách toàn bộ request/response DTO của HTTP API.
  - `server/os_integration.rs`: Tách `DirectoryPicker` / `NativeDirectoryPicker` và `WorkbookOpener` / `NativeWorkbookOpener`, loại bỏ hoàn toàn shell/script interpolation.
  - `server/state.rs`: Tách `AppState`, `ToolchainStore` và `ActiveBatchSession`.
  - `server/routes/{mod,system,discovery,judge,toolchains,export,osd}.rs`: Tách từng nhóm route theo miền nghiệp vụ; các route Giai đoạn B (`osd`, `toolchains/prewarm`) trả về `501 Not Implemented` trung thực.
- **Thêm `crates/judgedesk-core/src/storage.rs`:**
  - Cung cấp `OwnedWorkspace`, `ensure_safe_contained_path`, `validate_existing_directory_path`, `ensure_no_reparse_or_symlink_chain` và `is_symlink_or_reparse_point`.
  - Áp dụng `OwnedWorkspace` cho `engine/session.rs`, `engine/runner.rs`, `toolchains/diagnostics.rs` và kiểm tra containment cho `server/routes/export.rs`.

### 1.3. Tự phản biện (Adversarial Self-Review)
- **Phát hiện & khóa lỗ hổng tiềm ẩn 1:** Trong `OwnedWorkspace::create_with_id`, nếu thư mục đích đã tồn tại nhưng không có file `.judgedesk-workspace` hợp lệ (hoặc là symlink/reparse point), code ban đầu gọi `remove_dir_tree_no_follow` ngay. Đã sửa để xác minh `.judgedesk-workspace` (không phải symlink/reparse point và khớp nội dung marker) trước khi xóa thư mục cũ; nếu không khớp thì trả về lỗi từ chối ghi đè.
- **Phát hiện & khóa lỗ hổng tiềm ẩn 2:** Trong `OwnedWorkspace::write_file`, việc chặn ghi đè `.judgedesk-workspace` nay được kiểm tra trên đường dẫn `target` sau khi `resolve_contained_path` (chặn cả đường dẫn tương đối lẫn đường dẫn tuyệt đối trỏ vào marker).
- **Phát hiện & xử lý môi trường test Windows (`0xC0000142` với binary FPC trong LPAC):** Khi chạy dưới desktop cô lập `exebox-*`, binary Free Pascal (import `user32.dll` / `oleaut32.dll`) chạy trong `SandboxBoundary::Lpac` (có cờ `PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT`) cần quyền trên `WindowStation` và `Desktop` cho đúng package SID `JudgeDesk.NativeSecureExecutor.v1`. Đã bổ sung cấp quyền trong `crates/judgedesk-core/tests/common/mod.rs` mà không chạm vào binary `native-executor` đã đóng băng.

### 1.4. Bằng chứng nghiệm thu Bước 1
- `cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml --test step1_security_boundary_test`: **PASS (4/4)**.
- `cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml --test toolchain_diagnose_test -- --test-threads=1`: **PASS (8/8)**.
- Toàn bộ các test target còn lại trong `crates/judgedesk-core` (`--lib`, `api_contracts_test`, `build_identity_test`, `discovery_test`, `engine_execution_test`, `executor_boundary_test`, `rational_test`, `scoring_test`, `server_test`, `standard_checkers_test`, `test_wellformed_test`): **PASS (100%)**.
- `cargo clippy --locked --manifest-path crates/judgedesk-core/Cargo.toml --all-targets -- -D warnings`: **PASS (0 warnings)**.

---

## Bước 2 — Toolchain Store thật, Persistence, Managed Receipts & Helper `quick_verified_direct` / `freeze_required`

### 2.1. Vòng lặp TDD (`RED` → `GREEN`)
- **Test file mới:** `crates/judgedesk-core/tests/step2_toolchains_policy_test.rs` (5 kịch bản kiểm thử):
  1. `test_step2_preferences_atomic_persistence_and_no_fake_package_seeding`: Kiểm chứng thư mục `toolchains` trống không bao giờ tự seed gói giả (`installed_packages.is_empty()` và mọi gói trong `GET /api/toolchains` đều có `"installed": false`), đồng thời `PUT /api/toolchains/profiles/cpp/preference` ghi atomic `toolchain-preferences.json` theo Schema v2 tương thích Node (`cpp-legacy-v1`).
  2. `test_step2_strict_source_no_fallback`: Kiểm chứng `mode = "managed"`, `"local_path"`, `"none"` tuyệt đối không tự động fallback sang nguồn khác khi nguồn đã chọn thiếu hoặc lỗi.
  3. `test_step2_quick_verified_direct_and_macos_framework_python_resolution`: Kiểm chứng `resolve_macos_framework_python_executable` phân giải launcher stub `.../Python.framework/Versions/3.12/bin/python3` về binary interpreter trực tiếp `.../Resources/Python.app/Contents/MacOS/Python`, và `quick_verified_direct` từ chối binary giả/hỏng qua bounded native probe.
  4. `test_step2_freeze_required_blocks_unmatched_thumbprint`: Kiểm chứng helper `ExecutionPolicyMode::FreezeRequired` (`resolve_toolchain_for_profile_with_policy`) từ chối binary khi thiếu chứng chỉ hoặc sai lệch `certificate_thumbprint` / SHA-256 executable digest.
  5. `test_step2_managed_only_languages_and_active_judging_mutation_lock`: Kiểm chứng `pascal`, `java`, `scratch` từ chối `local_path` / `local_auto` (`400 Bad Request` — `LOCAL_NOT_SANDBOX_COMPATIBLE`), và các route thay đổi cấu hình đã gắn kiểm tra (`preference`, `install`, `uninstall`, `execution-policy`, `certify`, `custom-path`) trả về `409 Conflict` (`TOOLCHAIN_MUTATION_BLOCKED`) khi có `JudgeSessionLease` đang active.

### 2.2. Thay đổi kiến trúc & chính sách đã thực hiện (và giới hạn phạm vi hiện tại)
- **`crates/judgedesk-core/src/toolchains/discovery.rs`:**
  - Bổ sung `save_persisted_preferences_in` ghi atomic `toolchain-preferences.json` (Schema v2) qua temp file + `sync_all()` + `fs::rename`.
  - Bổ sung `discover_installed_managed_packages_in` xác minh `.judgedesk-package.json` receipt thực tế và sự tồn tại của entrypoint binary.
  - Bổ sung `ExecutionPolicyMode` (`ManagedOnly`, `QuickVerifiedDirect`, `FreezeRequired`), `resolve_macos_framework_python_executable`, `run_quick_verified_direct_probe` (bounded timeout) và helper `verify_binary_certificate_thumbprint` (băm SHA-256 của 1 file thực thi bằng Rust `std`, hoặc gọi PowerShell `Get-AuthenticodeSignature` trên Windows để đọc thumbprint 40-hex).
  - Loại bỏ toàn bộ nhánh fallback ngầm giữa `managed`, `local_path`, `local_auto` và `none`.
- **`crates/judgedesk-core/src/server/state.rs` & `routes/toolchains.rs` & `routes/judge.rs`:**
  - Xóa hoàn toàn đoạn seed 9 gói giả trong `ToolchainStore::default()`.
  - Thêm `JudgeSessionLease` (RAII) trong `AppState` để tự động khóa/mở khóa 6 route mutation toolchain (`execution-policy`, `preference`, `certify`, `custom-path`, `install`, `uninstall` trả `409 Conflict`) khi phiên chấm bài đang chạy.
- **Khoảng trống còn lại sẽ đóng ở Giai đoạn B (`WP2.2`–`WP2.6`):**
  - Wrapper `resolve_toolchain_for_profile` (`discovery.rs:1310`) hiện vẫn truyền `default_policy` (`ManagedOnly` / `QuickVerifiedDirect`) và `None` cho `expected_thumbprint`; việc nối `FreezeRequired` cùng kiểm tra toàn vẹn snapshot bất biến/dependency closure (tương đương `server/toolchains/certificate-readiness.ts`) vào đường chạy sản phẩm vẫn còn mở.
  - `POST /api/toolchains/rescan` (`toolchains.rs:697`) hiện vẫn trả tĩnh `202 Accepted` mà chưa kiểm tra active job hay chạy discovery thật; các route `certification-plan`, `certify`, `install`, `uninstall` vẫn là in-memory/stub.

### 2.3. Tự phản biện (Adversarial Self-Review)
- **Phát hiện & xử lý lỗi đường dẫn `\\?\` với MinGW `gcc.exe` trên Windows:** Khi dùng `std::fs::canonicalize` trên Windows, đường dẫn trả về có tiền tố `\\?\C:\...` khiến MinGW `gcc.exe` không tìm được `../libexec/gcc/.../cc1.exe` tương đối. Đã bổ sung `clean_canonical_path` cắt bỏ tiền tố `\\?\` trên Windows và cô lập biến môi trường `C_INCLUDE_PATH`/`CPATH` khỏi bước probe khám phá compiler để lỗi header của người dùng được báo đúng ở pha `compilation` thay vì `configuration`.

### 2.4. Bằng chứng nghiệm thu Bước 2
- `cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml --test step2_toolchains_policy_test -- --test-threads=1`: **PASS (5/5)**.
- `cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml --test server_test -- --test-threads=1`: **PASS (11/11)**.
- `cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml --test toolchain_diagnose_test -- --test-threads=1`: **PASS (8/8)**.
- `cargo clippy --locked --manifest-path crates/judgedesk-core/Cargo.toml --all-targets -- -D warnings`: **PASS (0 warnings)**.

---

## Bước 3 — Sandboxed Compiler Service & Bộ điều hợp Batch cho đủ 6 ngôn ngữ qua `ExecutorClient`

### 3.1. Vòng lặp TDD (`RED` → `GREEN`)
- **Test file mới:** `crates/judgedesk-core/tests/step3_sandboxed_compiler_runner_test.rs` (4 kịch bản kiểm thử):
  1. `step3_compiler_rs_contains_zero_host_command_spawns_and_enforces_timeouts`: Kiểm chứng tĩnh và động rằng `crates/judgedesk-core/src/engine/compiler.rs` hoàn toàn không chứa `std::process::Command` / `tokio::process::Command` và xuất đúng hằng số timeout `SUBMISSION_COMPILE_WALL_TIME_MS = 15_000` (15s), `CHECKER_COMPILE_WALL_TIME_MS = 60_000` (60s).
  2. `step3_compiler_provenance_distinguishes_ce_from_je`: Kiểm chứng `CompilationFailureProvenance::SubmissionError` (`status = "CE"` khi code thí sinh sai cú pháp C++/Python hoặc Java khai báo `package`) tách biệt hoàn toàn với `CompilationFailureProvenance::JudgeEnvironment` (`status = "JE"` khi `ExecutorClient` unavailable hoặc file nguồn bị mất).
  3. `step3_scratch_malformed_or_hostile_sb3_rejected_as_ce`: Kiểm chứng bộ giải nén ZIP + RFC 1951 raw INFLATE + CRC32 thuần Rust trong `compiler.rs` chặn archive hỏng, `project.json` thiếu `targets` và entry ZIP chứa `../evil.json` với `status = "CE"` (`SCRATCH_PROJECT_MALFORMED`), trong khi `.sb3` hợp lệ (kể cả nén Deflate method 8) pass với `status = "OK"`.
  4. `step3_six_language_batch_compile_and_run_via_executor_client`: Kiểm chứng trọn vẹn chu trình compile + batch run (`run_test_case`) qua `ExecutorClient` cho cả **6 ngôn ngữ** (`cpp`, `c`, `pascal`, `python`, `java` với `public class Solution`, và `scratch` `.sb3` nén Deflate) đều đạt `AC` (`score_multiplier = 1.0`).

### 3.2. Thay đổi kiến trúc & bảo mật đã thực hiện (và giới hạn phạm vi hiện tại)
- **Viết lại `crates/judgedesk-core/src/engine/compiler.rs`:**
  - Loại bỏ 100% lệnh gọi `std::process::Command` trên host; mọi lệnh biên dịch và kiểm tra cú pháp (`cpp`, `c`, `pascal`, `java`, `python`) đều chạy qua `ExecutorClient::run_sync` với `RunRole::Compiler`.
  - Hỗ trợ đầy đủ `compile_submission_with_executor` (`15_000ms`) và `compile_checker_with_executor` (`60_000ms`, tự động stage `testlib.h` vào workspace biên dịch).
  - Hỗ trợ kiểm tra AST/cú pháp Python (`-I -B -S -c ...`) trong sandbox, biên dịch `javac` cho Java (chặn `package`, tự động phát hiện public top-level class và ghi `.judgedesk-entrypoint`), và bộ parser/validator `.sb3`/`.sb2`/`.json` (ZIP + RFC 1951 Deflate + CRC32 + giới hạn kích thước chống Zip Bomb) thuần Rust `std`.
- **Nâng cấp `crates/judgedesk-core/src/engine/runner.rs` & `session.rs`:**
  - Bổ sung `build_submission_spec` hỗ trợ chạy batch trong `RunRole::Submission` cho cả 6 ngôn ngữ: native binary (`cpp`, `c`, `pascal`), Python (`JUDGEDESK_PYTHON_ISOLATED=1`, `-I -B main.py`), Java (`JUDGEDESK_JAVA_ISOLATED=1`, `-XX:+UseSerialGC`, `-XX:ActiveProcessorCount=1`, `-XX:+ExitOnOutOfMemoryError`, `-cp . <entrypoint>`), và Scratch (`JUDGEDESK_SCRATCH_ISOLATED=1`, `TURBO_MODE=1`).
  - Sửa `preview_text` dùng `is_char_boundary` để không bao giờ panic khi cắt chuỗi UTF-8 tiếng Việt nhiều byte.
- **Khoảng trống còn lại sẽ đóng tiếp (`WP3.1` / `WP4.1`):**
  - `compiler.rs:681-705` hiện vẫn cố định cờ `-O2`, `-std=c++14` / `-std=c11`, `-I.`, `-static` (non-macOS), `-Wl,--stack,66060288` (Windows), `-lm` (non-macOS C) mà chưa đọc `ProblemCompileConfig` (`schemaVersion: 1`, `profile: "themis" | "modern_ioi_icpc_2025" | "icpc_world_finals" | "custom"`, `flags: { cpp, c }`) mới bổ sung ở `v1.5.5` (`shared/compile-config.ts`).

### 3.3. Tự phản biện (Adversarial Self-Review)
- **Phát hiện & xử lý 1 (`MANAGED_RUNTIME_MARKERS` trong `RunRole::Compiler`):** `validate_run` của `native-executor` chỉ cho phép các biến môi trường `JUDGEDESK_PYTHON_ISOLATED` / `JUDGEDESK_JAVA_ISOLATED` khi `role` là `Submission` hoặc `CheckerRuntime`. Trong `compiler.rs` (`RunRole::Compiler`), đã loại bỏ biến marker này và dùng cờ `-I -B -S` trực tiếp cho Python syntax check.
- **Phát hiện & xử lý 2 (FPC trên Windows cần `-WR` khi chạy trong AppContainer):** Binary do `ppcx64.exe` tạo ra trên Windows nếu thiếu cờ `-WR` (relocation table) sẽ bị lỗi `ERROR_ILLEGAL_DLL_RELOCATION (623)` khi nạp trong AppContainer. Đã bổ sung `-WR -Xs -Cs66060288` vào `compile_native_submission` cho `pascal` trên Windows.

### 3.4. Bằng chứng nghiệm thu Bước 3
- `cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml --test step3_sandboxed_compiler_runner_test -- --test-threads=1`: **PASS (4/4)**.
- `cargo clippy --locked --manifest-path crates/judgedesk-core/Cargo.toml --all-targets -- -D warnings`: **PASS (0 warnings)**.

---

## Bước 4 — Session Lifecycle, Problem Config Normalization, Job Admission, Cancellation & Drain

### 4.1. Vòng lặp TDD (`RED` → `GREEN`)
- **Test file mới:** `crates/judgedesk-core/tests/step4_lifecycle_config_cancel_test.rs` (3 kịch bản kiểm thử):
  1. `step4_problem_config_precedence_and_normalization`: Kiểm chứng thứ tự ưu tiên `storedConfig` (`Config.cfg` > `config.json`) > `request.problemConfigs[problem]` > default; clamp `memoryLimit` vào `[8, 1024]` MB; `isInteractive == true` cưỡng bức `useStdIn = true, useStdOut = true` (`input_file_for_execution() == ""`, `output_file_for_execution() == ""`); và hỗ trợ `polygonConfig.tests[testName].timeLimit` theo từng test case.
  2. `step4_job_registry_admission_and_instant_cancel_kills_infinite_loop`: Kiểm chứng cancel-before-register tombstone (`POST /api/batch-judge/cancel` với `jobId` trước khi `/api/batch-judge` khởi tạo sẽ từ chối job ngay với `JUDGE_CANCELLED`), đồng thời kiểm chứng khi đang chạy bài nộp C++ lặp vô hạn (`while (true)` với TLE 10s), lệnh `POST /api/batch-judge/cancel` gửi `ExecutorRequest::Cancel` xuống `native-executor` và dừng phiên chấm tức thì trong `< 1.5s` với đúng **1 sự kiện kết thúc duy nhất** (`error: JUDGE_CANCELLED`, không phát kèm `done`).
  3. `step4_server_lifecycle_4_phases_drain_and_metadata_python_export`: Kiểm chứng metadata stream xuất đầy đủ cả `toolchains.cpp` và `toolchains.python` (tương thích `score-workbook.ts`), áp dụng `request.problemConfigs` (`defaultScore: 7`), và chuyển trạng thái `ServerLifecyclePhase` qua 4 pha (`Running` → `Draining` → `Stopping` → `Stopped`) khi gọi `/api/shutdown`, từ chối mọi job mới với `SERVER_DRAINING`.

### 4.2. Thay đổi kiến trúc & quản lý vòng đời đã thực hiện (và giới hạn phạm vi hiện tại)
- **`crates/judgedesk-core/src/discovery/testcase.rs` & `scoring.rs`:**
  - Bổ sung `NormalizedProblemConfig`, `normalize_problem_config`, `normalize_problem_memory_limit` (`[8, 1024]` MB) và `PolygonTestConfig::time_limit`.
- **`crates/judgedesk-core/src/executor_client.rs`:**
  - Theo dõi `active_run_ids` qua RAII `ActiveRunRegistration`, bổ sung `cancel_all_active_runs()` gửi `ExecutorRequest::Cancel` tới `native-executor` để diệt ngay tiến trình con đang chạy, và bổ sung `run_interactive_sync` / `run_interactive_async`.
- **`crates/judgedesk-core/src/server/state.rs`, `routes/judge.rs`, `routes/system.rs` & `engine/session.rs`:**
  - Bổ sung `ServerLifecyclePhase` (`Running`, `Draining`, `Stopping`, `Stopped`) và `JudgeJobRegistry` (`active_jobs` + `pending_cancellations` tombstones có TTL 60s).
  - Chuyển `run_judge_session` trong `handle_batch_judge` sang `tokio::task::spawn_blocking` để các lệnh IPC đồng bộ không bao giờ làm nghẽn worker bất đồng bộ của HTTP server.
  - Khóa fallback ngầm sang `C1` khi custom checker biên dịch lỗi (báo `JE` rõ ràng).
- **Khoảng trống còn lại sẽ đóng tiếp (`WP4.2`–`WP4.4`):**
  - `cancel_judge_job` (`state.rs:328`) hiện vẫn gán `self.cancel_flag = true` và gọi `cancel_all_active_runs()` ngay cả khi `requested_job_id` chưa active (ghi tombstone cho job B có thể hủy active run của job A); `handle_batch_judge_cancel` (`judge.rs:84`) luôn trả `200 OK` thay vì trả `500` khi executor không xác nhận cancel như Node (`jobs.ts:367`); và validation `jobId` trong `state.rs:253` đang giới hạn `<= 128` ký tự ASCII thay vì `<= 256` ký tự in được như Node.
  - `handle_batch_judge` (`judge.rs:70`) chưa gắn header `X-JudgeDesk-Job-Id` và `session.rs` phát `metadata` trước `progress(progress.initializing)`.

### 4.3. Tự phản biện (Adversarial Self-Review)
- **Phát hiện & xử lý nghẽn Tokio runtime khi chạy `run_sync`:** Ban đầu `handle_batch_judge` gọi `tokio::spawn(run_judge_session(...))`, trong đó `compile_submission_with_executor` và `run_test_case` gọi `platform.run_sync` chặn trực tiếp luồng worker của Tokio. Khi chạy trên runtime ít luồng hoặc `#[tokio::test]`, request `POST /api/batch-judge/cancel` bị giữ lại đến khi `run_sync` hết TLE 10s. Đã chuyển sang `tokio::task::spawn_blocking` để tách hoàn toàn luồng chấm bài khỏi luồng HTTP event loop.

### 4.4. Bằng chứng nghiệm thu Bước 4
- `cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml --test step4_lifecycle_config_cancel_test -- --test-threads=1`: **PASS (3/3)**.

---

## Bước 5 — Exact `BigUint` Rational Primitive, Sandboxed Custom Checkers & Interactive Runner

### 5.1. Vòng lặp TDD (`RED` → `GREEN`)
- **Test file mới:** `crates/judgedesk-core/tests/step5_rational_checker_interactive_test.rs` (3 kịch bản kiểm thử):
  1. `step5_exact_bigint_rational_overflow_and_long_decimal_precision`:
     - Cộng dồn $\sum_{k=1}^{25} \frac{1}{p_k}$ với 25 số nguyên tố đầu tiên (mẫu số chung $\prod_{k=1}^{25} p_k \approx 2.3 \times 10^{36} \gg \text{i64::MAX} \approx 9.22 \times 10^{18}$), sau đó trừ đi 24 số hạng đầu tiên và kiểm chứng thu được chính xác `"1/97"` (không tràn số, không bão hòa làm sai lệch điểm).
     - Parse chuỗi số thập phân dài 29 chữ số `"0.12345678901234567890123456789"`, nhân với $10^{29}$ và kiểm chứng thu được chính xác `"12345678901234567890123456789"` (không bị làm tròn qua mantissa 53-bit của IEEE-754 `f64`).
     - Rút gọn phân số lớn vượt quá `u128::MAX` (`"300000000000000000000000000000000000000000000/900000000000000000000000000000000000000000000"`) về đúng `"1/3"`.
  2. `step5_custom_checker_runs_inside_sandbox_and_zero_host_command_spawns_in_runner`:
     - Kiểm chứng tĩnh và động rằng `crates/judgedesk-core/src/engine/runner.rs` không chứa bất kỳ lệnh `std::process::Command` / `Command::new` nào.
     - Biên dịch custom checker C++ cố tình đọc file mật trên máy host bên ngoài sandbox (`host_secret_outside_sandbox.txt`) — xác nhận sandbox chặn hoàn toàn việc đọc file ngoài workspace, đồng thời hỗ trợ đầy đủ cả giao thức Testlib (`AC`, `WA`, `FAIL` exit code `3`) và chấm điểm thành phần (`0.5` qua `stdout`).
  3. `step5_interactive_problem_end_to_end_ac_and_wa`:
     - Kiểm chứng bài toán tương tác một lượt trao đổi (`GUESS.inp` chứa `N = 84`, `defaultScore = 10`) chạy qua `ExecutorClient::run_interactive_sync` (`ExecutorRequest::RunInteractive` nối ống `stdin`/`stdout` hai chiều giữa `submission` và `interactor.cpp` trong `native-executor`): `interactor.cpp` gửi `N` cho thí sinh và kiểm tra câu trả lời có bằng `N / 2` hay không; thí sinh `Alice` in `n / 2` (`42`) đạt `AC` (`score = 10.0`), thí sinh `Bob` in `n - 1` (`83`) nhận `WA` (`score = 0.0`).

### 5.2. Thay đổi kiến trúc & bảo mật đã thực hiện (và giới hạn phạm vi hiện tại)
- **`crates/judgedesk-core/src/rational.rs`:**
  - Nâng cấp `Rational` sang số nguyên lớn độ chính xác tùy ý (`BigUint` biểu diễn cơ số $2^{32}$ thuần `std`, không thêm crate ngoài `Cargo.lock`).
  - Hỗ trợ `gcd`, cộng, trừ, nhân, chia, so sánh, rút gọn phân số và `parse_rational` trực tiếp từ chuỗi thập phân/phân số độ dài tùy ý không đi qua `f64::parse`.
- **`crates/judgedesk-core/src/engine/runner.rs` & `session.rs`:**
  - Chuyển toàn bộ `run_custom_checker` (cả native checker và Python checker) sang chạy bên trong `ExecutorClient::run_sync` với `RunRole::CheckerRuntime` và workspace cô lập `OwnedWorkspace`.
  - Hỗ trợ đầy đủ cả quy ước Testlib (`stdin.txt`, `actual.txt`, `expected.txt` + mã thoát `0=AC`, `1=WA`, `2=PE`, `3=FAIL`, `7=PARTIAL`) lẫn quy ước Themis (`test/` + `work/` qua `themis.stdin` và parse điểm/log từ `stdout`/`stderr`).
  - Bổ sung `run_interactive_test_case` trong `runner.rs` và tích hợp luồng biên dịch + chạy `interactor` trong `session.rs` qua `ExecutorClient::run_interactive_sync`.
- **Khoảng trống còn lại sẽ đóng tiếp (`WP5.1` / `WP5.3`):**
  - Pipeline tính điểm từ custom checker/interactor (`custom.rs:10`, `session.rs:564`) vẫn đi qua `score_multiplier: f64` và `float_to_rational(..., 10000)`; `ProblemSummary` (`scoring.rs:76`) chưa xuất `scoreExact` / `maxScoreExact`.
  - `session.rs:550` chưa chia tỷ lệ trọng số từng testcase theo `totalScore` như `planProblemTestCases` của Node (`judge-session.ts:458`), và `scoring.rs:85` chưa cưỡng bức `score = 0`, `status = "JE"` khi có bất kỳ testcase nào bị `JE` (`scoring.ts:46`).

### 5.3. Tự phản biện & Xử lý tương thích đa nền tảng Windows + macOS (`judgedesk-mac`)
- **Phát hiện & xử lý 1 (Apple Clang sandbox contract trên macOS):** Trong `crates/judgedesk-core/src/engine/compiler.rs`, `native-executor` trên macOS yêu cầu `JUDGEDESK_COMPILER_TOOLCHAIN_ROOT`, `JUDGEDESK_COMPILER_DEVELOPER_ROOT`, `JUDGEDESK_COMPILER_EXECUTABLE`, cờ `--driver-mode=g++`, `-ccc-install-dir`, `-resource-dir`, `-isysroot` và staging `<bits/stdc++.h>`. Đã bổ sung `resolve_darwin_compiler_support` và ưu tiên Apple Clang (`/Library/Developer/CommandLineTools/usr/bin/clang++`) trước Homebrew `g++` trong `find_system_executable`.
- **Phát hiện & xử lý 2 (FPC linker & symlink bảo toàn trên macOS):** Khi sao chép gói toolchain managed trên macOS (`copy_dir_recursive`), các symlink thư viện hệ thống (`libSystem.dylib`, v.v.) cần được bảo toàn bằng `std::os::unix::fs::symlink` thay vì đệ quy/copy thường; đồng thời truyền `-FD` và `-Fl.../SDKs/MacOSX.sdk/usr/lib` cho Free Pascal trên macOS.
- **Phát hiện & xử lý 3 (Đường dẫn `/var/folders` -> `/private/var/folders` trên macOS):** Chuẩn hóa `OwnedWorkspace::create_in_temp` và `ensure_no_reparse_or_symlink_chain` cho phép firmlink hệ thống gốc của macOS (`/var`, `/tmp`, `/etc`) khi là thư mục cha trung gian nhưng vẫn chặn tuyệt đối mọi symlink bên dưới workspace.

---

## Tổng kết Kiểm định Thực thi (Giai đoạn A — Bước 1 đến Bước 5)

| Cổng kiểm định (Verification Gate) | Kết quả Windows (`x86_64-pc-windows-msvc`) | Kết quả macOS (`aarch64-apple-darwin` / `judgedesk-mac`) |
| :--- | :--- | :--- |
| `npm run release:check-version` (8-file lockstep `1.5.5`) | **PASS** (`1.5.5`) | **PASS** (`1.5.5`) |
| `npm run check:fast` (Typecheck + Quality Gate) | **PASS** | **PASS** |
| `cargo clippy --locked --manifest-path crates/judgedesk-core/Cargo.toml --all-targets -- -D warnings` | **PASS (0 warnings)** | **PASS (0 warnings)** |
| `cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml -- --test-threads=1` | **PASS (132/132 tests: 4 unit tests in `lib` + 128 integration tests across 16 test files)** | **PASS (133/133 tests: 4 unit tests in `lib` + 129 integration tests across 16 test files, bao gồm 1 test `#[cfg(unix)]` tại `discovery_test.rs:738`)** |




