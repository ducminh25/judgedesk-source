# Pure Rust Core: đối chiếu hiện trạng và công việc tiếp theo

> **Cập nhật đồng bộ hiện trạng & Quy trình thực thi mới (2026-10-17 — Checkout `488703a` + working tree):**
> - **Quy trình thực thi mới đã phê duyệt (2026-10-17):** Mon đã phê duyệt chuyển đổi quy trình dự án sang mô hình **4 Macro-Milestones (`M1`–`M4`) + Scoped Re-verification + JSON-Only Hash Binding** (xem [`docs/pure-rust-core-efficient-execution.md`](pure-rust-core-efficient-execution.md) và [`docs/pure-rust-core-review-workflow.md`](pure-rust-core-review-workflow.md)):
>   1. **Chốt `N0` (`N0-C10-GATE-R1`) theo Scoped Re-verification:** Trong vòng `candidate10` (`codex-independent-review-20261017T054000Z` + `codex-review-closure-20261017T065802Z`), lỗi `N0-C09-GATE-R1` (Mac paired process-quota / XNU zombie-only `EPERM`) đã được xác minh độc lập `74/74` PASS (`0` skips), cùng `91/91` production, Windows `948/958`, Mac `950/958`, `check:full`, `test:security`. Điểm mở duy nhất còn lại của `N0` là P2 **`N0-C10-GATE-R1`** (`npm run test:macos-process-supervisor` phát hiện executor giữ 2 fd generation guard `3u, 5u` khi có run/prewarm đồng thời). Vòng tiếp theo của `N0` chỉ cần sửa lỗi này và chạy **Scoped Re-verification** (không chạy lại các bộ test Windows/Mac không liên quan).
>   2. **4 Macro-Milestones (`M1` $\rightarrow$ `M4`):**
>      - **`M1` (`WP0.6` $\rightarrow$ `G5`):** Hoàn thiện toàn bộ lõi chấm bài, bảo mật, Toolchain, Batch & Interactive (`Bước 1–5` + đóng khoảng trống P0/P1: `ProblemCompileConfig`, pipeline `Rational` xuyên suốt + chia tỷ lệ `totalScore` + `JE = 0`, cancel theo `jobId`, `FreezeRequired` + `rescan`/install/certify thật) kèm Bảng ánh xạ 1-1 `WP*` Traceability Matrix.
>      - **`M2` (`WP6.1a` $\rightarrow$ `G6`):** OSD Daemon tương thích Themis Web (`WP6.1a–c`) & hoàn thiện toàn bộ HTTP routes / archive / export (`WP6.2`, `WP6.3`, `G6`).
>      - **`M3` (`WP7.1` $\rightarrow$ `G8`):** Universal PCH & Selective Prewarm (`WP7.1–7.4`, `G7`) + bộ kiểm chứng 100% Parity tuần tự Node vs Rust (`WP8.1–8.3`, `G8`).
>      - **`M4` (`V9.1` $\rightarrow$ `G10`):** Kiểm thử đóng gói Desktop 2 hệ điều hành (`V9.1–V9.4`, `G9`), chuyển mặc định sang Rust Core `v1.6.0` (`WP10.1–10.5`) và gỡ bỏ Node (`WP10.6`, `G10`).
> - **Phân tách phiên bản:**
>   - **Application source baseline (8-file lockstep):** `1.5.5` (`npm run release:check-version` PASS).
>   - **Crate `crates/judgedesk-core/Cargo.toml`:** `1.5.1` (giữ riêng theo quy định không trở thành file thứ 9 của app lockstep).
>   - **Mục tiêu cutover (`WP10.3`):** `1.6.0`.
>   - **Các mốc lịch sử (`1.5.0`, `1.5.1`):** Giữ nguyên trong hồ sơ lịch sử bên dưới.
> - **Trạng thái sổ cái nghiệm thu chính thức (`docs/verification/pure-rust-core/STATUS.md`):** `WP0.1`–`WP0.5` là `DONE`; `N0` (`candidate10` / `N0-C10-GATE-R1`) và `WP0.6` đang `IN_PROGRESS`; `Phase gates: 0 / 11 DONE`.
> - **Tiến độ triển khai trong working tree (`Bước 1–5` — xem [`docs/reports/pure-rust-core-progress-2026-10-14.md`](reports/pure-rust-core-progress-2026-10-14.md)):** Đã triển khai trong `crates/judgedesk-core` và vượt qua `clippy --all-targets -- -D warnings` cùng `132/132` tests trên Windows (`x86_64-pc-windows-msvc`) và `133/133` tests trên macOS (`aarch64-apple-darwin` / `judgedesk-mac`). Kết quả này là bằng chứng thực thi trong working tree, sẽ được hợp nhất và nghiệm thu độc lập tại **Macro-Milestone `M1` (`WP0.6..G5`)**.

---

## 0. Đối chiếu hiện trạng `v1.5.5` + `Bước 1–5` và các khoảng trống còn lại (Cập nhật 2026-10-15)

### 0.1. Bảng ánh xạ `Bước 1–7` sang các gói công việc `WP*` trong DAG

| Bước triển khai | Nội dung | Ánh xạ gói `WP*` (DAG) | Trạng thái trong `crates/judgedesk-core` (Working Tree) |
| :--- | :--- | :--- | :--- |
| **Bước 1** | Tách module `server/` (`auth`, `dto`, `os_integration`, `state`, `routes/*`), `OwnedWorkspace` (`storage.rs`), bỏ script interpolation, trả `501` cho route chưa làm | `WP0.7`, `WP1.2`, `WP1.3`, `WP1.5`, `WP1.6` | Đã có implementation + `step1_security_boundary_test` (4/4) |
| **Bước 2** | Xóa seed 9 gói giả, lưu atomic `toolchain-preferences.json` (Schema v2), đọc `.judgedesk-package.json`, `ManagedOnly` / `QuickVerifiedDirect` + helper `FreezeRequired`, khóa 6 route mutation khi chấm (`409`) | Một phần `WP2.2`, `WP2.3`, `WP2.6`, `WP2.7`, `WP3.3` | Đã có implementation cơ sở + `step2_toolchains_policy_test` (5/5); còn thiếu `rescan` thật, `install`/`uninstall`/`certify` thật và nối `FreezeRequired` + snapshot closure vào `resolve_toolchain_for_profile` |
| **Bước 3** | Đưa 100% lệnh biên dịch (`cpp`, `c`, `pascal`, `java`, `python`) vào `ExecutorClient::run_sync` (`RunRole::Compiler`), validator `.sb3` thuần `std`, bộ điều hợp batch 6 ngôn ngữ | Một phần `WP3.1`, `WP3.2` | Đã có implementation cơ sở + `step3_sandboxed_compiler_runner_test` (4/4); còn thiếu đọc/áp dụng `ProblemCompileConfig` (`shared/compile-config.ts`) |
| **Bước 4** | `NormalizedProblemConfig`, `ServerLifecyclePhase` (4 pha), `JudgeJobRegistry` + tombstone 60s, `ExecutorRequest::Cancel`, `spawn_blocking`, xuất `toolchains.python` trong metadata | Một phần `WP4.1`–`WP4.5` | Đã có implementation cơ sở + `step4_lifecycle_config_cancel_test` (3/3); còn thiếu tách cancel ownership theo từng `jobId`, trả HTTP 500 khi cancel không xác nhận, validation `jobId <= 256`, header `X-JudgeDesk-Job-Id` và thứ tự `progress(initializing)` trước `metadata` |
| **Bước 5** | Nâng cấp `Rational` sang `BigUint` độ chính xác tùy ý, đưa custom checker vào `RunRole::CheckerRuntime`, nối `run_interactive_test_case` qua `ExecutorRequest::RunInteractive` | Một phần `WP1.4`, `WP5.1`, `WP5.3`, `WP5.4` | Đã có implementation cơ sở + `step5_rational_checker_interactive_test` (3/3); còn thiếu giữ `Rational` xuyên suốt từ custom checker/interactor (bỏ `f64` multiplier), xuất `scoreExact`/`maxScoreExact`, chia tỷ lệ `totalScore` và quy tắc `JE`歸0 điểm |
| **Bước 6** | Hoàn thiện Toolchain Package Lifecycle (download/extract/install/uninstall/dedup/certify thật, nối `FreezeRequired`) + Universal PCH & Selective Background Prewarm (`nativeCompilerKindsToPrewarm`) | Phần còn lại của `WP2.2`–`WP2.6` + `WP7.1`–`WP7.4` | Chưa triển khai (`POST /api/toolchains/prewarm` đang trả `501`) |
| **Bước 7** | OSD Daemon tương thích Themis Web + hoàn thiện parity route cấu hình/archive/export và bộ kiểm chứng corpus tuần tự Node vs Rust | `WP6.1a`–`WP6.1c`, `WP6.2`, `WP6.3`, `WP8.1`–`WP8.3` | Chưa triển khai (`/api/osd/*` đang trả `501`) |

### 0.2. Danh sách các khoảng trống Parity (P0 / P1) giữa Node `v1.5.5` và `crates/judgedesk-core` hiện tại

| Mức độ | Hạng mục & Bằng chứng mã nguồn | Chi tiết khoảng trống cần đóng trong `crates/judgedesk-core` |
| :--- | :--- | :--- |
| **P0** | **Cấu hình biên dịch `ProblemCompileConfig` (`ProblemConfigModal` tab `compile` mới từ `v1.5.1`→`v1.5.5`)**<br/>- Node/Shared: [`shared/compile-config.ts`](../shared/compile-config.ts#L1-L216), [`server/problems/config-normalization.ts`](../server/problems/config-normalization.ts#L62), [`server/routes/discovery-routes.ts`](../server/routes/discovery-routes.ts#L429-L448), [`server/judge/compiler.ts`](../server/judge/compiler.ts#L316-L353).<br/>- Rust: [`discovery/testcase.rs:272-287`](../crates/judgedesk-core/src/discovery/testcase.rs#L272-L287), [`routes/discovery.rs:171`](../crates/judgedesk-core/src/server/routes/discovery.rs#L171), [`engine/compiler.rs:681-705`](../crates/judgedesk-core/src/engine/compiler.rs#L681-L705). | 1. Bổ sung `ProblemCompileConfig` (`schemaVersion: 1`, `profile: "themis" \| "modern_ioi_icpc_2025" \| "icpc_world_finals" \| "custom"`, `flags: { cpp, c }`) và `assert_safe_compile_flag` / `normalize_problem_compile_config`.<br/>2. Kiểm tra hợp lệ `config.compile` trong `POST /api/polygon-config` (trả `400 INVALID_COMPILE_CONFIG` nếu cờ nguy hiểm/rỗng) và chuẩn hóa trong `GET /api/polygon-config`.<br/>3. Thay bộ cờ C++/C đang cố định tại `compiler.rs:681-705` (`-O2`, `-std=c++14`/`-std=c11`, `-I.`, `-static`, `-Wl,--stack,66060288`, `-lm`) bằng bộ cờ lấy từ `NormalizedProblemConfig.compile.flags` + linker/platform args. |
| **P0** | **Pipeline điểm `Rational` xuyên suốt, chia tỷ lệ `totalScore` & quy tắc `JE` = 0 điểm**<br/>- Node: [`server/judge/judge-session.ts:430-478`](../server/judge/judge-session.ts#L430-L478), [`server/judge/scoring.ts:46-54,134`](../server/judge/scoring.ts#L46-L54).<br/>- Rust: [`checkers/custom.rs:10-79`](../crates/judgedesk-core/src/checkers/custom.rs#L10-L79), [`engine/session.rs:550-574`](../crates/judgedesk-core/src/engine/session.rs#L550-L574), [`rational.rs:790-792`](../crates/judgedesk-core/src/rational.rs#L790-L792), [`scoring.rs:76-156,272-288`](../crates/judgedesk-core/src/scoring.rs#L76-L156). | 1. Parse điểm thành phần của custom checker/interactor trực tiếp sang `Rational` thay vì `f64` (`score_multiplier: f64` + `float_to_rational(..., 10000)`).<br/>2. Bổ sung `scoreExact` và `maxScoreExact` vào `ProblemSummary`.<br/>3. Khi bài toán cấu hình `totalScore` (không bật `enableGroups`), chia tỷ lệ điểm từng test theo $\text{totalScore} \times \frac{w_i}{\sum w_j}$ giống `planProblemTestCases`.<br/>4. Khi `compileStatus == "JE"` hoặc bất kỳ testcase nào có `status == "JE"`, ép `ProblemSummary.status = "JE"`, bỏ qua cộng điểm group và gán tổng điểm bài = `0`. |
| **P1** | **Cancellation theo đúng `jobId`, xác nhận lỗi cancel & header/thứ tự sự kiện Batch Stream**<br/>- Node: [`server/jobs.ts:68,157-166,367-379`](../server/jobs.ts#L157-L166), [`server/judge/batch-judge-route.ts:111-118`](../server/judge/batch-judge-route.ts#L111-L118).<br/>- Rust: [`server/state.rs:253-260,328-352`](../crates/judgedesk-core/src/server/state.rs#L328-L352), [`server/routes/judge.rs:70-100`](../crates/judgedesk-core/src/server/routes/judge.rs#L70-L100), [`engine/session.rs:75-120`](../crates/judgedesk-core/src/engine/session.rs#L75-L120). | 1. Gắn quyền sở hữu run theo từng `jobId`: khi cancel một `jobId` chưa active, chỉ ghi tombstone cho `jobId` đó, tuyệt đối không bật `cancel_flag` toàn cục hay gọi `cancel_all_active_runs()` làm chết job khác đang chạy.<br/>2. Trả HTTP `500` từ `POST /api/batch-judge/cancel` nếu hủy native run không được xác nhận; đồng bộ validation `jobId <= 256` ký tự in được.<br/>3. Trả header `X-JudgeDesk-Job-Id` trên `POST /api/batch-judge`, phát `progress(progress.initializing)` trước `metadata`, và kiểm tra `isTextFile` cho file input khi `testWellFormed == false`. |
| **P1** | **Hoàn thiện Toolchain Lifecycle, `FreezeRequired` wiring & Selective Prewarm (Bước 6 / `WP2.2–2.6`, `WP7.1–7.4`)**<br/>- Node: [`server/toolchains/certificate-readiness.ts:239`](../server/toolchains/certificate-readiness.ts#L239), [`server/toolchains/migration.ts`](../server/toolchains/migration.ts), [`server/judge/background-prewarm.ts:74-105`](../server/judge/background-prewarm.ts#L74-L105).<br/>- Rust: [`toolchains/discovery.rs:796-850,1310-1324`](../crates/judgedesk-core/src/toolchains/discovery.rs#L1310-L1324), [`server/routes/toolchains.rs:697-1020`](../crates/judgedesk-core/src/server/routes/toolchains.rs#L697-L1020), [`server/routes/system.rs:25-70`](../crates/judgedesk-core/src/server/routes/system.rs#L25-L70). | 1. Nối `FreezeRequired` + xác thực toàn vẹn snapshot/certificate closure vào `resolve_toolchain_for_profile` (và kiểm tra `$sig.Status -eq 'Valid'` khi xác minh chữ ký Authenticode).<br/>2. Triển khai thật `POST /api/toolchains/rescan` (kèm khóa mutation khi đang chấm), `certification-plan`, `certify`, `install`, `uninstall`, và dedup migration `migrateLegacyBundledToolchains`.<br/>3. Đồng bộ `GET /api/status` (`system.rs`) lấy trạng thái `gpp`/`python` thực từ `ToolchainStore`.<br/>4. Triển khai Universal PCH cache (hash bao gồm cả `compile.flags`) và `POST /api/toolchains/prewarm` có chọn lọc (`nativeCompilerKindsToPrewarm`). |
| **P1** | **OSD Daemon tương thích Themis Web (Bước 7 / `WP6.1a–c`)**<br/>- Node: [`server/judge/osd-service.ts`](../server/judge/osd-service.ts), [`server/routes/osd-routes.ts`](../server/routes/osd-routes.ts), [`docs/osd-themis-compatibility.md`](osd-themis-compatibility.md).<br/>- Rust: [`server/routes/osd.rs`](../crates/judgedesk-core/src/server/routes/osd.rs). | Triển khai đầy đủ OSD service thay cho stub `501`: hỗ trợ tên file có dấu chấm và không dấu chấm (`0[HS01][SUM]cpp`), atomic claim `.judgedesk-osd-*`, kiểm tra ổn định file theo `fd`/`inode`/`mtime`/SHA-256, lưu trữ `$History`, ghi log CRLF `logs/<raw-filename>.log` (`HS01‣SUM: ...`, hiển thị `ℱ Lỗi hệ thống chấm` khi `JE`), và phát SSE tại `GET /api/osd/events`. *(Lưu ý: phân biệt rõ hành vi hiện tại của Node `osd-routes.ts` trả `400` khi `start()` thất bại với yêu cầu mục tiêu `503` khi `secureRunner.ready == false` của `WP6.1c`).* |

---

## Lịch sử khảo sát ban đầu (Historical Baseline Snapshot — 2026-09-19)

Ngày kiểm chứng ban đầu: 2026-09-19. Checkout Windows: `d80f997` cùng các thay đổi chưa commit tại thời điểm đó. Các mục từ Phần 1 đến Phần 6 dưới đây được giữ nguyên làm hồ sơ lịch sử của đợt khảo sát `v1.5.0`.

**Trạng thái phiên bản (tại thời điểm 2026-09-19):** `v1.5.0` là bản đã phát hành và là baseline được kiểm chứng bên dưới. Các thay đổi hướng tới `v1.6.0`.

## 1. Kết luận (Snapshot 2026-09-19)

**Cần khép các khoảng trống về bảo mật, toolchain và API trước khi ưu tiên Universal PCH.** Stage 1 có self-test thật trên Windows nhưng chưa đạt tương thích sản phẩm hoặc đa nền tảng. Stage 3 đã có implementation một phần, không phải chưa bắt đầu. Stage 4 chưa đủ điều kiện cutover.

JudgeDesk vẫn là ứng dụng chấm thi offline: React quản lý workspace, cấu hình, bảng điểm, kết quả và export; Tauri quản lý cửa sổ, archive, lifecycle; Node là backend mặc định; native executor thực thi sandbox. Rust core mới cần thay thế toàn bộ trách nhiệm Node mà giữ nguyên hợp đồng với các lớp còn lại.

Đã đối chiếu AGENTS.md, guidelines.md, CONSTRAINTS.md, migration plan, index và các phần liên quan của PRD/TRD/APP_FLOW/BACKEND_SCHEMA/UI_UX_DESIGN, cùng code và tests của Rust core, backend Tauri, compiler Node, frontend judging/export/toolchains. Áp dụng các skill code-review-and-quality, security-and-hardening, debugging-and-hardening và computer-use. Có một lượt review độc lập chỉ đọc cho API/frontend parity.

## 2. Những phát hiện cần xử lý (Snapshot 2026-09-19)

Các số dòng dưới đây là của snapshot khảo sát ngày 2026-09-19 (nhiều mục P0/P1 đã được giải quyết một phần hoặc toàn phần trong Bước 1–5 như đối chiếu tại Mục 0 ở trên).

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
