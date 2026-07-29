# JudgeDesk — Kế hoạch hỗ trợ đa ngôn ngữ

Trạng thái: **Đã duyệt để triển khai Phase 0/1, có amendment D15**

Ngày khảo sát: 2026-07-28

Baseline đã đọc: `main` tại commit `b1ed52f`, tag `v1.2.7`

Nền tảng mục tiêu hiện tại: Windows 10/11 x64 và macOS Apple Silicon

Phạm vi thay đổi tại thời điểm duyệt: chưa đổi logic chấm, chưa chọn hay tải toolchain mới.

## Decision log

Ngày duyệt: 2026-07-28

- D1–D9: duyệt theo đề xuất trong tài liệu.
- D10: bỏ qua, không phải blocker và không tạo cam kết triển khai Ruby/Haskell/Cangjie trong roadmap hiện tại.
- D11–D14: duyệt theo đề xuất trong tài liệu.
- D15: duyệt với amendment: local compiler/runtime có thể trở thành Submission ready nếu version/target nằm trong policy được JudgeDesk hỗ trợ và vượt health + sandbox certification; UI/source selection theo mô hình ở D15 mới.
- Sau D15: JudgeDesk là single-instance. Lần mở thứ hai không được spawn backend/executor hay chạy startup cleanup/mutation; nó phải gửi activation request có timeout cho primary, làm cửa sổ primary hiện lại, bỏ minimize và lấy focus rồi thoát sạch. Activation IPC và ownership lease phải dùng chung một authority, không ghép hai cơ chế có thể race.
- Fast discovery lần đầu: chỉ auto-detect thụ động; không tự chạy full certification cho toolchain mới phát hiện.
- Default source cho profile ngôn ngữ mới: đang chờ xác nhận sau khi giải thích UX; không tự suy diễn từ việc detect được compiler/runtime.
- Branch namespace: dùng `judgedesk/…` theo lựa chọn của chủ dự án; branch nền tảng là `judgedesk/language-runtime-foundation`.
- Cách làm: từng bước nhỏ; không phụ thuộc việc luôn có máy Mac. Mỗi thay đổi macOS phải có test có thể chuẩn bị trước, nhưng chỉ được xác nhận runtime khi đã chạy trên Apple Silicon thật.

### Execution checkpoint

- Foundation đã push tại `b2e793c` trên `judgedesk/language-runtime-foundation`; checkpoint hiện tại đang làm trên `judgedesk/macos-run-guardian`.
- Base: `main` / `b1ed52f` / `v1.2.7`.
- Hoàn tất: audit/research/approval; characterization fixtures, typed foundation contracts và preferences v2 migration kernel fail-closed đã được commit và push trên branch foundation.
- Đang làm: source checkpoint chung + Windows đã chuyển sang một coordinator có lifetime lease, authenticated activation/focus `Starting → Ready → Draining`, backend startup gate fail-closed và internal process-tree supervisor. Judge cancellation dùng barrier `reserved → started → completed`: cancel trong lúc chuẩn bị chặn submit, cancel sau submit chỉ nhắm run đang thực sự active, và phản hồi native `false` không còn bị coi là thành công. Exact debug snapshot đã vượt unit/contract/SEA smoke và destructive single-instance/crash gate; packaged installer/updater gate vẫn chưa chạy.
- Windows containment hiện dùng một helper headless của chính `JudgeDesk.exe` để giữ `process-tree.lock` và backend-only Job. Helper này không tạo Tauri/WebView/backend thứ hai; nó là recovery authority nhỏ và được tính riêng trong process inventory. Trên debug build đã đo khoảng 11 MiB working set; số release phải đo lại trên packaged candidate.
- macOS hiện dùng helper PGID riêng, exclusive owner lock + generation descriptor, authenticated `ASSIGN/DRAIN/DRAINED/EXIT_ACK`, `kqueue NOTE_EXIT` có latch, backend stdin làm parent-liveness channel và native executor giữ shared generation guard tới khi mọi accepted/active run đã teardown xong. Khi drain, helper nâng generation descriptor thành exclusive lock và chỉ đi tiếp sau khi toàn bộ shared guard đã nhả. Không truyền ambient owner/control descriptor vào backend; packaged gate kiểm tra helper giữ owner descriptor + generation descriptor, executor chỉ giữ generation descriptor, GUI/backend không giữ các descriptor này trong trạng thái bình thường.
- D15 registry/storage/API/UI slice đã hoàn tất trên branch `judgedesk/d15-language-profile-registry` cho đúng hai profile C++/Python hiện hữu; chưa bật profile ngôn ngữ mới. Preferences v2, passive first-run discovery, fixed source intent không fallback, bảng/radio/status/action dùng chung cho first-run và Manager, cùng khóa mutation khi batch active đã nối live. Certification/snapshot, manifest v2, generic adapter/preflight pin và language spike vẫn chưa làm.
- Windows evidence trên exact snapshot: Rust `12 pass / 3 ignored helper`; full server/frontend regression `205 pass / 4 platform skip`; lint pass; SEA thiếu token bị chặn trước listen và SEA có token vượt health/routes/executor/parent-channel EOF; Tauri debug build pass. Runtime gate đạt restore + foreground, 20 secondary exit sạch trong 173–266 ms, primary-crash recovery không overlap backend/executor, supervisor-crash drain và normal shutdown drain. Working set quan sát ở debug snapshot: GUI 43.3 MiB, supervisor 11 MiB, backend 41.9 MiB, executor 7 MiB. Sau gate không còn process thuộc executable test.
- Windows còn pending: packaged MSI/release build; active submission child/grandchild crash gate; hidden/busy window; Tauri updater install/autolaunch. Host-run Python checker đã bị loại bỏ: managed Python dùng typed `checker-runtime` trong AppContainer + Job, output cap 256 KiB và ordinary cancel chỉ ACK sau khi run rời cả active/accepted registry. Checker checkpoint đạt Rust `36 lib + 3 binary`, Clippy strict, lint, full server `212 tests / 208 pass / 4 platform skip` và full security `16 tests / 15 pass / 1 macOS-only skip`; C++ `testlib.h` đã compile-run thật qua `compiler → checker`. Local/system runtime chưa có certified snapshot phải fail-closed. Double forced-failure của cả primary và supervisor chưa có barrier proof tuyệt đối; `KILL_ON_JOB_CLOSE` giảm rủi ro nhưng không được ghi là verified. `tauri-plugin-updater` 2.10.1 vẫn là release blocker cho đến khi pin bản official đã sửa và packaged update gate đạt.
- Bước kế tiếp theo checkpoint đã duyệt: review/merge slice D15 registry/UI, rồi tiếp tục certificate/snapshot + preflight/batch pin trước khi mở profile C. Automatic recovery khi guardian chết, performance budget, packaged Windows/updater và phần còn lại của fault matrix D16 tiếp tục là blocker độc lập; bản hiện tại vẫn cố ý fail closed và không numeric-signal supervisor từ executor.
- Mac evidence trên Apple Silicon thật qua Tailscale/SSH: Cargo Tauri `11 pass / 1 helper skip`; native executor `8 pass`; full server/frontend regression `207 pass / 2 platform skip`; TypeScript lint pass; sidecar startup/parent-EOF smoke + native security matrix `9 pass / 1 Windows-only skip`; Clang và managed Python smoke pass; ad-hoc signed ARM64 `.app` build pass. `scripts/macos-process-supervisor-gate.sh` trên exact packaged app theo dõi cả khoảng chạy 20 secondary và drain window, xác nhận helper/backend/executor không đổi PID dù transient GUI secondary được phép, normal shutdown rỗng, GUI `SIGKILL` giữa submission dài rồi relaunch không overlap/mixed generation, submission PGID cũ rỗng, helper `SIGKILL` làm backend/executor dừng và primary giữ recovery locks, secondary không tự dựng backend mới, rồi restart sạch. Focus/restore normal và minimized đã được kiểm tra qua GUI trước gate.
- Mac per-run guardian evidence bổ sung ngày 2026-07-29 trên M1 8 GB: production native path dùng guardian + persistent trusted supervisor; Rust `62 pass + 1 binary pass`, Clippy strict pass; full security `10 pass / 1 Windows-only skip`; destructive guardian fault gate `5 TAP tests`; process bomb đạt; hai lượt 900/900 no-op hoàn tất và không còn process dư. Stress đã phát hiện rồi sửa race descendant biến mất giữa identity/status sampling và race terminal frame direct. Audit cuối còn phát hiện rồi loại bỏ numeric direct fallback không có owned reap pin: guardian `SIGKILL` sau target start nay giữ generation fail closed, không trả unproven result và không signal PID/PGID. Ambient FD scan hơn một triệu `close`/child từng làm p50 gần 300 ms đã bị thay bằng `POSIX_SPAWN_CLOEXEC_DEFAULT`. Adjacent base end-to-end p50/p95 là 14,916/18,103 ms; exact source sau final safety patch và benchmark-harness guard đo 24,618/27,208 ms, dispatch residual 13,209/14,133 ms, sandbox setup 0,407/0,594 ms và backend RSS tăng 8,91 MiB. Absolute dispatch gate cũ 5/10 ms vẫn đỏ, nên performance chưa được gọi release-ready; benchmark độc lập nay tự provision guard tạm và từ chối partial guard environment. Checkout sạch đúng GitHub SHA `323db233…` đã vượt integrated sidecar gate; local ad-hoc DMG CI-safe 43,8 MB cũng qua ARM64, codesign, JIT entitlement và packaged sidecar smoke với SHA-256 `8c341548…`. Interactive Finder aesthetics qua SSH timeout `-1712` được tách khỏi headless gate, không bị ghi nhầm thành lỗi app.
- Checker hardening exact implementation commit `0e32793c1aa48cfb822208345f165fb80a1d5359` ngày 2026-07-29 đã được fetch từ GitHub vào clean worktree trên cùng M1: tracked tree sạch; Rust `63 lib + 3 binary pass`, Clippy strict và lint đạt; full server `212 tests / 210 pass / 2 platform skip`; full security `16 tests / 15 pass / 1 Windows-only skip`. Gate đã compile-run checker C++ `testlib.h` qua role `compiler → checker`, chứng minh native checker chặn private-file/network/child process; managed Python `checker-runtime` chặn các boundary tương tự, từ chối `execve` một Mach-O sibling trong chính package và chỉ ACK cancel sau terminal drain. Gate TLE 1 giây từng lộ một scheduler flake 200 ms ở repetition 16; chỉ test window được đổi thành 2 giây để giữ nguyên ma trận 80/120%, sau đó 20/20 dưới biên và 20/20 trên biên đạt. Production TLE không đổi. Sau gate exact-SHA: zero executor, profile, workspace và tree-guard dư.
- Packaged checkpoint exact commit `d4448fd40b79c87d2fc5869abf362f313a56c467` đã build lại trong clean detached worktree trên M1. Local ad-hoc ARM64 DMG có SHA-256 `0400b1ee9ca4db3c8d9a0aa8f3c9dee804ff6a5f6fb73b8751da6f647de98686`; architecture, deep codesign, JIT entitlement, sidecar token/parent-EOF và secure-runner health đều đạt. Process/single-instance/crash-recovery gate đạt hai lượt liên tiếp với exact `executor → guardian → supervisor` identity chain, 20 secondary launches, GUI crash giữa run, old PGID drain, helper crash boundary, replacement health và final cleanup. Gate đóng gói riêng compile-run bài C++, checker C++ `testlib.h`, managed Python checker và cancel-drain đều đạt trong app-data cô lập. Một lỗi cleanup thật từ các lượt crash cũ đã được sửa: executor chỉ reset `workspaces/artifacts/profiles` sau khi giữ generation guard, bảo toàn managed `toolchains` và từ chối symlink. Kiểm kê cuối: 0 runtime process, 0 workspace, 0 Seatbelt profile và 0 fixture. Windows regression cho thay đổi này đạt Rust `40/40`, Clippy strict, lint/build, full server `212 tests / 208 pass / 4 platform skip` và security `16 tests / 15 pass / 1 macOS-only skip`; hai suite dùng executor cache chung phải chạy tuần tự.
- D15 registry/UI checkpoint gồm implementation `779c81e`, macOS discovery-only correction `22f9343` và test-harness/exact packaged build `a26beb518a80a5edea4294607266d68b04204ad4`. Windows full regression đạt `228 tests / 224 pass / 4 platform skip` cả trước và sau correction; main implementation đạt production build, Rust `40/40`, Clippy strict và security `15 pass / 1 macOS-only skip`. Trên M1, exact `a26beb5` đạt full regression `226 pass / 2 Windows-only skip` và security `15 pass / 1 Windows-only skip`; ARM64 ad-hoc DMG SHA-256 `0f89c84575eeb6d76f19010365c095b27773992c27fc228eaab3ce2b70400584` qua codesign/JIT/sidecar/Apple Clang/secure-runner. Exact packaged gate chứng minh registry + bốn source mode, C++ submission/checker, managed Python checker, mutation 409 trong batch, cancel-drain, uninstall và zero-leak inventory. Chi tiết cùng giới hạn còn lại nằm ở `docs/d15-language-profile-registry-checkpoint.md`.
- Mac vẫn pending trước khi gọi D16 hoàn tất: automatic recovery sau guardian death chưa có owned direct-child/group pin và hiện cố ý fail closed; simultaneous forced death của executor + guardian cùng run vẫn là fault boundary không được claim; simultaneous double forced-failure GUI + helper với guardian/checker active chưa có packaged proof; hidden/busy focus, updater relaunch, notarized/updater DMG gate, 8-run/soak matrix và minimum/current macOS matrix chưa đạt. Local ad-hoc DMG và exact-SHA packaged gates đã verified nhưng không thay thế các gate này. Các giới hạn còn lại phải tiếp tục fail-closed và được công bố thay vì gắn nhãn verified.

## 1. Kết luận điều hành

Việc thêm các ngôn ngữ trong hai ảnh là khả thi, nhưng không nên thực hiện bằng cách chỉ thêm phần mở rộng file và chuỗi lệnh biên dịch. JudgeDesk hiện được xây quanh hai nhánh C++/Python; một số chỗ còn có dạng “nếu không phải C++ thì coi là Python”. Nếu thêm ngôn ngữ trực tiếp vào discovery, kết quả có thể là chạy nhầm runtime thay vì từ chối rõ ràng.

Đường đi được đề xuất:

1. Xây một lớp nền tảng `LanguageProfile` có phiên bản, giữ nguyên kết quả chấm của contest C++/Python hợp lệ và không mơ hồ; các thay đổi fail-closed/preflight có chủ ý phải được ghi riêng.
2. Tổng quát hóa toolchain, artifact, sandbox capability, preflight và metadata.
3. Phát hành theo nhóm nhỏ, mỗi nhóm chỉ được nâng lên “Ổn định” sau khi qua đủ Windows x64 và macOS ARM64 trên bản app đóng gói thật.
4. Giữ toolchain dưới dạng gói tùy chọn, tải/cài trước kỳ thi và dùng hoàn toàn offline khi chấm.
5. Chỉ nhận mã nguồn trong chế độ thi chính thức. `.exe` và `.class` là artifact đã biên dịch, không phải ngôn ngữ; đề xuất tiếp tục từ chối.

Có hai trục ưu tiên cần tách rõ:

- Theo nhu cầu thi phổ thông/Themis: **C rồi Pascal**. Pascal phải qua spike macOS riêng và không được giữ release C lại.
- Theo độ sẵn sàng kỹ thuật: **C rồi Go** là đường native ít rủi ro hơn Pascal/Java/Rust.
- Wave tiếp theo: **Java và Rust**, lần lượt mở rộng JVM/artifact thư mục và linker/toolchain nặng.
- Managed/JIT wave sau: **JavaScript (Node.js) và C#/.NET**; Java đã mở nền JVM/JIT ở wave trước.
- Gói tùy chọn: **Ruby và Haskell**.
- Chỉ nghiên cứu/thử nghiệm: **Cangjie** cho đến khi toolchain, giấy phép phân phối, runtime ABI và sandbox đều đủ ổn định.

Lộ trình cuối cùng có thể ưu tiên Pascal vì giá trị giáo dục, nhưng gate và branch phải độc lập để C/Go không bị chặn bởi FPC. Đây không phải đánh giá giá trị của ngôn ngữ.

## 2. Các nguyên tắc không được phá vỡ

### 2.1. Tính đúng và công bằng

- Một source không rõ ngôn ngữ phải bị từ chối với lỗi rõ ràng; không có fallback ngầm sang Python, C++ hay runtime bất kỳ.
- Cùng input, checker và profile đã khóa phải cho cùng loại phán quyết trên hai nền tảng, trừ khác biệt đã được mô tả và kiểm thử rõ.
- Không dùng hệ số thời gian ẩn theo hệ điều hành.
- Nếu dùng hệ số hoặc phần bù thời gian/bộ nhớ theo ngôn ngữ, chúng phải có phiên bản, hiển thị được, ghi vào metadata và được hiệu chỉnh bằng benchmark.
- Mỗi testcase tiếp tục chạy trong process mới; không dùng daemon/runtime dùng chung giữa các thí sinh.
- Một app instance có tối đa một batch active và batch tiếp tục chạy tuần tự theo chính sách tài nguyên hiện tại, phù hợp máy giáo viên cấu hình thấp.

### 2.2. An toàn

- Compiler và submission không được chạy qua shell chung. Nếu upstream bắt buộc wrapper script, profile chỉ được gọi một interpreter đã allowlist cùng immutable script cụ thể; không mở `/bin/sh`, PowerShell hay command processor tùy ý.
- Không mạng trong compile và run của submission. Custom checker là một trust boundary riêng được mô tả ở mục 9.
- Không tự tải package, module, compiler hay dependency trong khi chấm.
- Giai đoạn đầu chỉ hỗ trợ một source chính và standard/core library; không Cargo crates, npm packages, NuGet packages, Go module từ mạng, gems, Cabal/Hackage.
- Managed package được pin phiên bản/digest, kiểm tra hash/chữ ký, có license notice và health check. Platform toolchain dùng certified identity/version/SDK tuple theo D14, không giả vờ có package digest.
- Submission chỉ được quyền đọc/chạy đúng runtime package đã chọn cùng verified system roots tối thiểu (loader, OS libraries, locale/ICU/certificate roots nếu recipe cần); không được nhìn thấy user/global package store hay toàn bộ kho JDK/.NET/Node/Rust/GHC.
- Compiler, runtime và checker đi qua executor bằng capability riêng; quyền của compiler/checker không được rò sang submission. Không có trusted-host exception: nếu không thể biểu diễn bằng typed role và sandbox đã chứng minh thì phải fail closed.

### 2.3. Khả dụng trong kỳ thi

- Có bước “Kiểm tra sẵn sàng kỳ thi” trước khi bấm Chấm.
- Báo một lần toàn bộ source mơ hồ, checker lỗi, gói còn thiếu, OS không hỗ trợ, dung lượng cần tải và dung lượng trống.
- Cho phép tải trước và import gói offline; tuyệt đối không để một batch đang chạy mới bắt đầu tải toolchain.
- Có preset “Chỉ cài ngôn ngữ cần cho kỳ thi này”.
- Reload giữ nguyên lựa chọn bài/thí sinh hiện có và chỉ bổ sung source mới phát hiện.
- Lỗi phải dùng ngôn ngữ sản phẩm: “Thiếu Java 21 cho macOS ARM64”, không chỉ hiện `ENOENT` hoặc stack trace.

## 3. Hai ảnh và CPH cho thấy gì — và chưa cho thấy gì

Ảnh Themis cho thấy các recipe theo extension, gồm `.cpp`, `.c`, `.pas`/`.pp`, `.java`, `.py` và đường tắt cho `.exe`/`.class`. Ảnh CPH liệt kê C++, C, C#, Rust, Go, Haskell, Python, Ruby, Java, JavaScript và Cangjie.

CPH hữu ích để tham khảo UX và cách ánh xạ ngôn ngữ sang command, nhưng nó là một tiện ích biên dịch/chạy cục bộ. JudgeDesk còn phải giải quyết các yêu cầu mà một command launcher không tự giải quyết: nguồn toolchain đáng tin, sandbox, process-tree accounting, TLE/MLE/OLE, artifact cache, checker, reproducibility, offline contest và parity giữa hệ điều hành. CPH mang giấy phép GPL-3.0-or-later, vì vậy chỉ học mô hình ở mức ý tưởng; không sao chép mã nếu chưa có phân tích giấy phép riêng.

Nguồn tham khảo:

- [CPH repository](https://github.com/agrawal-d/cph)
- [CPH compiler mapping](https://github.com/agrawal-d/cph/blob/main/src/compiler.ts)
- [CPH license](https://github.com/agrawal-d/cph/blob/main/LICENSE)

## 4. Hiện trạng JudgeDesk đã xác minh

| Khu vực | Hiện trạng | Hệ quả nếu thêm extension ngay |
|---|---|---|
| Contract dispatch | `SubmissionLanguage = "cpp" \| "python"` trong `shared/contracts.ts` | Compile/discovery/toolchain contracts không dispatch được ngôn ngữ mới; riêng result/archive validator đã dung nạp chuỗi language hơn và cần giữ tương thích |
| Discovery | Chỉ nhận `.cpp` và `.py`; dùng file đầu tiên khớp basename trong `server/judge/submission-discovery.ts` | Hai source cùng tên có thể bị chọn theo thứ tự filesystem |
| Compile | `server/judge/compiler.ts` dùng nhánh C++, còn nhánh khác đi về Python | Ngôn ngữ chưa biết có nguy cơ bị chạy như Python |
| Run | `server/judge/testcase-runner.ts` cũng có nhánh C++/còn lại là Python | Không có fail-closed cho adapter thiếu |
| Toolchain | `ToolchainKind`, manifest, resolver, preferences, routes và UI chỉ có C++/Python | Thêm package mới có thể ghi nhầm preference hoặc không hiển thị |
| Artifact | Cache compile hiện mô hình hóa một executable file | Java class tree và .NET bundle không phù hợp |
| Runtime validation | Executable nằm trong toolchain cache chỉ được mở bằng marker đặc biệt của Python | Không thể mở rộng an toàn bằng cách nhân bản env marker |
| macOS compiler sandbox | Compiler role hiện xác thực theo Apple Clang/Xcode/CLT | FPC, Go, Rust, javac, cjc, GHC sẽ bị chặn |
| Toolchain visibility | Windows ACL và macOS Seatbelt hiện mở phạm vi kho toolchain khá rộng | Thêm SDK làm tăng attack surface cho mọi submission |
| Resource policy | Một bộ giới hạn compiler/run dùng cho hai ngôn ngữ; Windows ép affinity một CPU, macOS không có cơ chế tương đương | Managed/JIT và compiler nặng có thể bị đánh giá sai hoặc lệch OS |
| Metadata/export | Các slot C++/Python được đóng cứng | Không tái lập được môi trường của ngôn ngữ mới |
| Release gates | Stress/gate hiện chủ yếu C++/Python | “Compile được trên máy dev” chưa đủ để gọi là hỗ trợ |

Các vị trí quan trọng khác:

- `server/toolchains/types.ts` và `server/toolchains/manifest.ts`: package hiện chỉ có một `executableRelativePath`.
- `server/executor/workspace.ts`: managed toolchain được import/copy vào cache; artifact chỉ là một regular file.
- `native-executor/src/request_validation.rs`: logic capability đang gắn riêng với Python.
- `native-executor/src/platform/windows.rs` và `macos.rs`: policy process, filesystem và compiler khác nhau.
- `server/platform/run-metadata.ts` và `src/features/export/score-workbook.ts`: metadata toolchain cố định.
- `src/features/contest/contest-file.ts`: archive hiện khá dung nạp đối với chuỗi language; thêm source language đơn thuần chưa buộc tăng `formatVersion`.

### 4.1. Hai phát hiện phải tái hiện trước khi kết luận là bug

1. File output hiện được đọc với giới hạn; cần xác minh trường hợp output vượt ngưỡng có bị cắt rồi đưa cho checker thay vì trả OLE hay không.
2. Quota write/file hiện nhìn trạng thái còn lại trong workspace; cần xác minh chương trình ghi-xóa lặp có vượt cumulative I/O mà không bị bắt hay không.

Hai mục này là hypothesis có căn cứ từ code, chưa được ghi là lỗi đã tái hiện. Chúng phải nằm trong Phase 0/1 vì các compiler có cache nặng sẽ làm rủi ro rõ hơn.

## 5. Phạm vi sản phẩm ban đầu

### 5.1. Có trong phạm vi

- Source đơn-file theo quy ước cụ thể cho từng ngôn ngữ.
- Standard/core library đi kèm toolchain.
- Stdin/stdout và file I/O theo quy ước hiện tại của JudgeDesk.
- Built-in checker hiện có.
- Custom checker source C++ và Python hiện có.
- Windows 10/11 x64 và macOS Apple Silicon.
- Gói toolchain được JudgeDesk quản lý, cài online trước kỳ thi hoặc import offline.
- Metadata đủ để tái lập hoặc giải thích: profile, version, argv, managed-toolchain digest hay platform-certified identity, OS/arch và giới hạn hiệu lực.

### 5.2. Chưa có trong phạm vi

- Project nhiều source do người dùng cung cấp.
- Package manager/dependency bên thứ ba.
- Docker/WSL làm runner mặc định.
- Tự chạy binary `.exe`, `.class`, `.jar` hoặc DLL do thí sinh nộp.
- Arbitrary compiler command/template do người dùng nhập trong chế độ thi chính thức.
- Custom checker viết bằng mọi ngôn ngữ mới ngay trong đợt đầu.
- Khẳng định strict security/TLE/MLE cho một profile chỉ dựa trên unit test hoặc source inspection.

## 6. Ma trận ngôn ngữ đề xuất

Mức “Ổn định” dưới đây chỉ là đích; chưa ngôn ngữ mới nào đạt mức đó ở baseline hiện tại.

| Ngôn ngữ | Extension dự kiến | Kiểu chạy dự kiến | Upstream có target Windows/macOS ARM64 | Rủi ro chính | Đợt đề xuất |
|---|---|---|---|---|---|
| C | `.c` | Native file/bundle | Tái dùng GCC Windows và Apple Clang macOS | C driver/standard/flags; system SDK identity | Wave 1 Stable |
| Pascal | `.pas`, `.pp` | Native file/bundle | FPC có gói Windows x64 và macOS ARM64 | Developer Tools/linker/SDK macOS, dialect, `Extended` và độ cũ compiler | Wave 1 riêng sau spike |
| Go | `.go` | Native single-file | Official archive cho cả hai | Compiler subprocess/cache, auto toolchain, GC/goroutine | Wave 2 |
| Java | `.java` | JVM, artifact directory | Temurin hỗ trợ cả hai | `Main` contract, JIT/startup/RSS, classpath, helper threads | Wave 2 |
| Rust | `.rs` | Native file/bundle | Target chính thức cho cả hai | Linker Windows/macOS SDK, compile RAM/time, stdlib tree | Wave 2 |
| JavaScript | `.js` | Node.js runtime + source | Official binaries cho cả hai | V8 JIT/threads/RSS, module/addon resolution | Wave 3 |
| C# | `.cs` | .NET runtime + bundle | .NET hỗ trợ cả hai | SDK lớn, restore/MSBuild import, JIT/RSS, multi-file artifact | Wave 3 |
| Ruby | `.rb` | Runtime + source | Windows dễ hơn; macOS packaging cần nghiên cứu | Gem/load path, runtime supply chain, encoding | Optional |
| Haskell | `.hs` | Native file/bundle sau GHC | Có toolchain cho cả hai | Package DB, dynamic dependencies, dung lượng, compile RAM/time rất cao | Optional |
| Cangjie | `.cj` | Native/runtime bundle | SDK có mục tiêu hai nền tảng | Tài liệu vendor chưa bảo đảm đầy đủ tính toàn vẹn Windows/macOS; macOS `libffi`; license/runtime ABI | Experimental/deferred |

Nguồn nền tảng chính thức đã kiểm tra để chuẩn bị spike; version cụ thể vẫn phải được pin và thẩm định tại thời điểm triển khai:

- [Go downloads](https://go.dev/dl/)
- [Free Pascal downloads](https://docs.freepascal.org/download.html)
- [Eclipse Temurin releases](https://adoptium.net/temurin/releases/)
- [Rust platform support](https://doc.rust-lang.org/rustc/platform-support.html)
- [Node.js release archive](https://nodejs.org/en/download/releases/)
- [.NET downloads](https://dotnet.microsoft.com/en-us/download)
- [GHCup installation](https://www.haskell.org/ghcup/install/)
- [Ruby installation](https://www.ruby-lang.org/en/documentation/installation/)
- [Cangjie Community installation](https://docs.cangjie-lang.cn/en/docs/1.0.0/user_manual/source_en/first_understanding/install_Community.html)

“Upstream có target” không đồng nghĩa profile chạy trên mọi OS JudgeDesk đang hỗ trợ. Minimum OS thay đổi theo version: tại thời điểm khảo sát, các dòng Go/Node/.NET mới có baseline macOS khác nhau, còn FPC/GHC có thể cần Apple Command Line Tools. Phase 0 phải pin một version còn được upstream hỗ trợ và khai báo minimum OS theo package; không suy ra khả năng tương thích chỉ từ việc có file ARM64. Xem [Go minimum requirements](https://go.dev/wiki/MinimumRequirements), [Node.js supported platforms](https://github.com/nodejs/node/blob/main/BUILDING.md), [.NET on macOS](https://learn.microsoft.com/en-us/dotnet/core/install/macos) và [FPC platform requirements](https://www.freepascal.org/docs-html/current/user/usersu2.html).

### 6.1. Recipe nền dự kiến, chưa phải cấu hình đã duyệt

- **C:** GCC/Clang C driver, optimization `-O2`, standard được chốt ở mục quyết định; không sao chép `-static` từ Themis sang macOS.
- **Pascal:** FPC, giữ khả năng source tự khai báo `{$mode ...}`; pin config và mọi support root.
- **Go:** standard library only; `GOTOOLCHAIN=local`, `GOPROXY=off`, `GOSUMDB=off`, `GOWORK=off`, `GOENV=off`, `CGO_ENABLED=0`; cache/temp riêng.
- **Java:** stage source thành `Main.java` nếu chọn contract `public class Main`; cấm `package` ở profile đầu; `javac -encoding UTF-8 -proc:none --release <pinned-level>`; class directory là artifact; xóa `CLASSPATH`, `JAVA_TOOL_OPTIONS` và `JDK_JAVA_OPTIONS`. Phase 0 đánh giá riêng profile runtime JDK 21 và JDK 25; dùng `--release 21` trên JDK 25 chỉ khóa language/API/class-file target, không biến runtime JDK 25 thành runtime JDK 21.
- **Rust:** `rustc` single-file với `std`, không Cargo/crates; spike Windows GNU và MSVC trước khi chọn.
- **Node.js:** CommonJS single-file ở phiên bản đầu; không npm/addons; xóa `NODE_OPTIONS`/`NODE_PATH`; sandbox OS là lớp bảo vệ chính.
- **C#:** JudgeDesk tạo project sạch, cố định và offline; không đọc `Directory.Build.*`, NuGet config hay source directive ngoài policy. Spike direct Roslyn so với `dotnet build --no-restore` trước khi chốt.
- **Ruby/Haskell:** core/standard library only, không gems/Cabal/Hackage.

### 6.2. Gate license và phân phối

Hash/chữ ký chứng minh package không bị đổi; chúng không tự tạo quyền redistribute. Ma trận sơ bộ dưới đây chỉ để định tuyến legal/release review, không thay thế việc đọc license/notices của đúng binary được chọn:

| Hệ sinh thái | Nghĩa vụ cần xác minh trên đúng package |
|---|---|
| GCC | GPL cùng GCC Runtime Library Exception; source/notice obligations khi redistribute compiler |
| LLVM/Apple Clang | Apache-2.0 with LLVM Exceptions; Apple toolchain/SDK là platform dependency riêng |
| FPC | License compiler và RTL khác nhau; kiểm tra modified LGPL/linking exception và source/notices |
| Temurin/OpenJDK | GPLv2 with Classpath Exception cùng third-party notices |
| Go | BSD-style license và notices |
| Rust | Dual MIT/Apache-2.0 cùng bundled component notices |
| Node.js | MIT cùng danh sách third-party licenses |
| .NET | MIT cho phần chính, nhưng phải inventory toàn SDK/runtime bundle |
| GHC | BSD-style license cùng nhiều third-party components |
| Ruby | Ruby License/BSD terms tùy thành phần/build |
| Cangjie | Apache-2.0/Runtime Library Exception theo distribution được chọn |

Mỗi pack phải phân biệt ba lớp: upstream checksum/signature, chữ ký manifest/package của JudgeDesk, và yêu cầu platform signing/notarization/quarantine/SmartScreen. Repack binary upstream có thể làm thay đổi hành vi Gatekeeper/Defender dù digest nội bộ hợp lệ.

Gate redistribute/license notice/SBOM áp dụng bắt buộc cho managed pack và mọi package/snapshot được export sang máy khác. Local-in-place hoặc snapshot bất biến chỉ dùng lại trên chính máy đã chứng nhận vẫn phải lưu provenance, fingerprint và certificate, nhưng không bị giả định là một distribution package của JudgeDesk.

## 7. Kiến trúc đích

### 7.1. Registry ngôn ngữ có phiên bản

Tạo một registry nội bộ, typed và được review cùng app; đây không phải hệ plugin bên thứ ba có thể chạy command tùy ý.

Một `LanguageProfile` tối thiểu gồm:

- `id`, `profileVersion`, tên hiển thị và trạng thái `stable/experimental`.
- Extension và quy tắc entry point.
- Target OS/architecture và minimum OS.
- Toolchain capabilities cần cho compile/run.
- Compile adapter và launch adapter trả argv dạng mảng tuyệt đối.
- Kiểu artifact và quy tắc validate.
- Environment allowlist/denylist.
- Compile/run resource profile.
- Source policy: single-file, standard library, module/package/network.
- Health probes và conformance suite version.

Mọi dispatch phải là exhaustive switch hoặc registry lookup fail-closed. Profile không tồn tại, thiếu adapter hay version không hỗ trợ phải dừng ở preflight/CE cấu hình rõ ràng, không rơi vào ngôn ngữ khác.

### 7.2. Discovery xác định

- Map extension qua registry.
- Nếu một basename có nhiều source hợp lệ, không chọn file đầu tiên.
- Preflight hiển thị tất cả ứng viên và cho người dùng chọn rõ; lựa chọn được lưu theo contest/problem/contestant.
- Nếu file biến mất sau Reload, báo trạng thái missing; không tự đổi sang extension khác một cách im lặng.
- “Không tìm thấy bài” mang language `unknown`/`missing`, không mặc định `cpp`.
- Cân nhắc alias `.cc`/`.cxx` sau khi chốt chính sách, với cùng quy tắc ambiguity.

### 7.3. Toolchain manifest v2

Tổng quát từ một executable sang package có nhiều component:

- Package ID/version, platform, arch, minimum OS.
- Compiler, linker, runtime, standard library/support roots.
- Upstream URL, SHA-256, chữ ký JudgeDesk, license/SPDX, notices/SBOM.
- Kích thước tải và kích thước cài.
- Executable và data roots được phép theo từng role.
- Health probe compile/run.
- Dependency giữa package nếu thật sự cần.

Giữ reader tương thích manifest v1 cho C++/Python trong thời gian migration. Preferences chuyển từ field riêng C++/Python sang map theo capability ID, nhưng phải migrate một chiều có test và không làm mất custom path hiện có.

Không bundle tất cả SDK vào installer. UI chỉ cài pack cần thiết; có offline export/import cho phòng thi không mạng. Version không được tự đổi giữa một batch.

Tách ba khái niệm, không dồn vào một enum:

- Selection source: `none | managed | local_path | local_auto`.
- Provenance/certification: `managed-package | platform-certified | certified-local | unverified-local`.
- Capability theo role: `checkerReady` và `submissionReady` cùng diagnostics.

Một Apple Clang tìm qua `xcrun` là selection `local_auto` nhưng provenance `platform-certified` nếu identity/SDK nằm trong policy. Một GCC local đạt toàn bộ gate là `certified-local` và có thể `submissionReady=true`. Migration không được vô tình mở rộng system/auto Python hiện tại thành submission runtime.

### 7.4. Local discovery và certification

Resolver dùng pipeline hai tầng:

1. Fast discovery thụ động/bất đồng bộ: stored path, managed store, PATH và allowlist vị trí chuẩn; không recursive scan và không tự thực thi mọi candidate.
2. Certification theo yêu cầu/certificate cũ: canonical identity, version/target/support roots, compile-run fixture, exact sandbox probe và fingerprint pinning.

Version policy là dữ liệu của `LanguageProfile`, dùng exact allowlist hoặc bounded range có minimum/maximum/tested majors; không chấp nhận mọi future major chỉ vì lớn hơn minimum. Exact entry pin family/distributor/version/build và identity policy; fingerprint của installation candidate chỉ được tạo sau discovery/certification và nằm trong certificate. Probe có timeout/output cap, probe role và không chạy qua shell. Local toolchain mặc định được snapshot closure vào immutable cache; direct platform root chỉ dùng khi có policy riêng. Một candidate chỉ được chọn làm submission compiler khi certification record còn khớp fingerprint hiện tại.

Storage/API chuyển từ các field `customCppPath`/`preferredSourceCpp` riêng lẻ sang:

- `schemaVersion`.
- Preferences v2 có `profiles[profileId]` với mode và optional remembered local path; path có thể dormant khi mode khác hoặc còn thiếu khi intent là `local_path`, để fail-closed mà không đổi radio.
- Installed-package inventory là state riêng được dựng lại từ disk + verified manifest, không copy `installedToolchains` legacy vào preferences như nguồn chân lý.
- Certificate cache là state versioned riêng, keyed bằng `certificateId`; certificate tự pin profile/version/role/candidate fingerprint/recipe/host/policy, vì một candidate fingerprint có thể phục vụ nhiều scope khác nhau.

Migration v1 dùng kernel thuần, được test riêng và không tự ghi. Tính atomic thuộc storage boundary kế tiếp và chỉ được công bố khi đã có test writer/CAS. UI contract trả danh sách profile động, candidate sources, selected source, readiness theo role, diagnostics và actions; không trả đúng hai slot C++/Python.

Chi tiết UX/action/version/fingerprint/preflight nằm ở D15.

### 7.5. Một cache bất biến, không copy SDK nhiều lần

- Content-addressed cache theo digest.
- Import nguyên tử: tải/stage, verify, rồi rename vào cache.
- Không copy cả JDK/.NET/GHC vào executor workspace cho mỗi lần dùng.
- Compiler SDK và runtime roots được tách capability; submission chỉ thấy runtime tối thiểu cần thiết.
- Có một canonical installed-package store cùng quota/eviction policy; executor workspace chỉ giữ reference/bản dẫn xuất cần thiết.
- App không thể biết mọi archive `.judgedesk` nằm ngoài máy. Uninstall chỉ bảo vệ các contest/profile đang mở hoặc đã đăng ký trong local index, rồi cảnh báo rằng archive cũ có thể cần tải/import lại đúng version/digest khi mở. Missing pinned package phải đi vào preflight recovery, không làm archive hỏng.

### 7.6. Artifact bundle

Thay `executablePath` đơn lẻ bằng `PreparedProgram`/`ArtifactBundle`:

- `native-file`: C/C++/Go và profile khác chỉ khi dependency inspection chứng minh đủ.
- `native-bundle`: native entrypoint cùng runtime companions đã hash, có thể cần cho Pascal/Rust/Haskell tùy target.
- `script-source`: Python/Node/Ruby.
- `directory-entry`: Java classes.
- `managed-bundle`: .NET DLL + runtimeconfig/deps cần thiết.

Bundle có tree digest, entrypoint, argv/env, số file, tổng dung lượng và executable policy. Khi import artifact do compiler tạo cho submission:

- Từ chối symlink, junction/reparse point và path escape.
- Giới hạn số file, chiều sâu và tổng bytes.
- Không cho artifact chứa tool hoặc file ngoài recipe.
- Cache key gồm source digest, profile version, compiler/runtime package digest hoặc certified platform identity, toàn argv/env ảnh hưởng compile, OS và arch.

Toolchain package có quy tắc khác artifact thí sinh: được phép giữ internal symlink cần thiết của SDK chỉ khi manifest đã ký liệt kê nó, canonical target vẫn nằm trong package root và không có cycle. Link escape/cycle và reparse target bên ngoài luôn bị từ chối.

Tên artifact type không được coi là bằng chứng self-contained. Với output native, gate phải inspect dependency closure bằng PE/Mach-O tools trên binary thật: dependency chỉ được trỏ vào verified OS allowlist hoặc runtime companion đã nằm trong bundle và được hash. Pascal, Rust và Haskell có thể phải chuyển từ `native-file` sang bundle tùy target/toolchain.

### 7.7. Executor capability tổng quát

Không nhân bản `JUDGEDESK_PYTHON_ISOLATED` cho từng runtime. Protocol phải truyền capability đã được server xác minh, gắn với package digest và role:

- `compiler:<package>`
- `runtime:<package>`
- `checker:<package>`

Windows phải dùng role-specific SID/capability hoặc một cơ chế immutable-root tương đương; không thay ACL dùng chung theo từng request theo cách có thể tạo race/TOCTOU. macOS Seatbelt cấp read/execute đúng selected package roots và verified system roots. Digest/root được khóa khi bắt đầu batch và package bị thay sau cài hoặc giữa batch phải làm request fail-closed. Test bắt buộc: một submission C++ không được chạy `node`, `java`, `cjc` hay bất kỳ binary nào từ package khác dù package đó đã cài.

Compiler policy macOS phải được tổng quát hóa có kiểm soát thay vì “cho chạy mọi thứ trong toolchain cache”. Mỗi compiler profile khai báo executable/support roots và subprocess nào được phép. JIT runtimes phải có spike riêng về executable memory, helper threads, child process và tổng RSS.

### 7.8. Contest language policy

Contest có một policy additive, phiên bản hóa:

- Các profile được phép dùng trong kỳ thi.
- Profile/toolchain version cùng managed digest hoặc certified platform identity đã pin.
- Resource policy version tương ứng.
- Trạng thái preflight tại thời điểm bắt đầu batch.

Contest cũ không có policy vẫn mở theo semantics C++/Python tương thích. App update không được âm thầm đổi compiler/runtime cho một lần re-grade của contest đã pin; người tổ chức phải chủ động nâng profile và nhận báo cáo khác biệt. Hỗ trợ giới hạn ngôn ngữ riêng theo từng problem có thể bổ sung sau, không cần nằm trong release đầu.

## 8. Resource policy và máy cấu hình thấp

### 8.1. Giữ các đặc tính tốt hiện tại

- Một judge session dùng một batch, không chạy nhiều thí sinh song song.
- Process mới cho từng testcase.
- Process-tree termination khi timeout/cancel.
- Giới hạn tổng tài nguyên app ở bản Windows đóng gói tiếp tục là release gate; không âm thầm nâng để một compiler mới “vừa”.

### 8.2. Bổ sung profile theo ngôn ngữ

Mỗi profile có:

- Compile timeout/memory/process/thread/file/write quota.
- Run process/thread/file/write quota.
- Runtime startup allowance, time factor và explicit language memory allowance/factor nếu được duyệt.
- Stack policy.
- Output limit.
- Runtime concurrency policy có thể gồm `GOMAXPROCS`, JVM/.NET processor count hoặc GHC RTS settings, nhưng chỉ khi đúng build mode hỗ trợ và đã benchmark. Các biến/flag này thay đổi môi trường chương trình quan sát được; chúng không phải hint dùng chung và không thay OS containment/aggregate CPU accounting.

Giới hạn yêu cầu của đề và giới hạn hiệu lực phải cùng xuất hiện trong UI/metadata. Phần memory allowance không thể dành riêng cho runtime ở cấp OS: submission có thể dùng toàn bộ giới hạn hiệu lực, vì vậy phải công khai đúng công thức và không gọi nó là “runtime overhead được tách riêng”. Không tính `-Xmx` hay V8 heap limit là MLE đầy đủ; MLE phải dựa trên tổng process tree. Với limit quá thấp để runtime khởi động, profile phải có verdict/config policy đã chốt và giống nhau trên hai OS, không để lúc là MLE, lúc là RE ngẫu nhiên.

### 8.3. Benchmark bắt buộc

Benchmark trên ít nhất:

- Windows x64 8 GB RAM, CPU phổ thông/đời cũ đại diện máy giáo viên.
- Mac Apple Silicon 8 GB RAM đại diện baseline thấp.
- Máy dev/CI chỉ là tham chiếu, không thay thế hai baseline trên.

Với mỗi ngôn ngữ:

- Hello world cold start.
- CPU-bound quanh 0.8x/1.0x/1.2x TLE, lặp tối thiểu 20 lần.
- Memory quanh 0.8x/1.0x/1.2x MLE.
- Compile source nhỏ, vừa và compile-bomb.
- Artifact/cache cold và warm.
- Batch nhiều thí sinh để đo RSS app, disk growth và orphan process.

Nếu một toolchain bắt buộc máy cao hơn baseline, profile phải là opt-in/experimental hoặc bị từ chối; không nâng yêu cầu cả JudgeDesk một cách vô hình.

## 9. Checker và hợp đồng I/O

Checker về nguyên tắc không phụ thuộc ngôn ngữ submission: runner tạo output, rồi checker đọc input/answer/output. Vì vậy đợt đầu không cần mở rộng ngôn ngữ viết custom checker.

Custom checker là code của problem pack và phải được xem là untrusted ở execution boundary, dù người ra đề được tin cậy về mặt nội dung. Checker native đã biên dịch (C++ hiện tại; Rust/Go hoặc ngôn ngữ biên dịch khác trong tương lai) chạy bằng role `checker`; runtime thông dịch đã snapshot/chứng nhận chạy bằng role `checker-runtime`. Native validator ép cả hai role về đúng một process; cả hai cấm mạng, chỉ ghi workspace và đi qua cùng cancel/shutdown drain barrier. Cancel chỉ ACK sau khi run rời cả active/accepted registry; nếu drain timeout, executor ngừng admission và đi vào terminal drain. Không còn exception chạy checker trực tiếp trên host; local/system runtime chưa có snapshot/certificate phải Not available thay vì fallback.

Giới hạn filesystem phải được mô tả đúng theo OS. macOS Seatbelt chỉ cho `checker-runtime` process-exec đúng executable đã chọn, đọc package snapshot tương ứng cùng sealed system roots và workspace. Windows dùng regular AppContainer không capability + Job Object: checker đọc workspace, certified runtime cache và baseline Windows loader/AppContainer bắt buộc, nhưng không được mô tả sai thành allowlist filesystem tuyệt đối; gate thực thi phải chứng minh private user files, network và child process không thoát được.

Compile checker là phase riêng role `compiler`, không dùng quyền runtime checker. Smoke C++ `testlib.h` trên Windows đo khoảng 532 MiB private / 559 MiB working set và 12,8 giây khi chạy trực tiếp; cap compiler submission 512 MiB / 15 giây gây MLE/TLE giả. Vì vậy chỉ preflight custom checker dùng budget 768 MiB / 30 giây, vẫn tuần tự; submission compiler và checker execution giữ nguyên giới hạn của chúng. Budget này là ceiling, không cấp phát sẵn 768 MiB và không làm chậm testcase bình thường.

Policy đề xuất:

- Giữ built-in checkers hiện có và custom checker source C++/Python.
- Preflight compile/resolve checker theo từng problem trước batch nhưng chưa chạy checker. Thiếu checker toolchain chỉ chặn/đánh dấu lỗi cấu hình cho problem liên quan, không làm hỏng các problem độc lập và không chạy hết thí sinh rồi mới lặp JE.
- Tiếp tục từ chối custom checker `.exe`.
- Checker byte-exact tiếp tục so raw bytes.
- Text checker có hợp đồng UTF-8 rõ: answer invalid UTF-8 là lỗi dữ liệu đề; contestant invalid UTF-8 phải có verdict được định nghĩa riêng cho từng checker. Phase 0 phải lập bảng mapping C1–C4/Polygon thay vì dùng câu chung “WA/PE”. Đây là thay đổi semantics cần duyệt và regression test trước khi áp dụng.
- Không tự đổi decimal separator theo locale; environment chấm dùng locale xác định và checker float dùng quy tắc hiện có.
- CRLF/LF phải được test trên cả hai OS theo semantics từng checker, không normalize ở runtime một cách ngầm định.

Ma trận bắt buộc cho mỗi ngôn ngữ:

- Exact/token/case-sensitive hoặc các built-in mode tương ứng.
- Integer/real/Polygon-style floating checker nếu contest cấu hình.
- Custom C++ checker.
- Custom Python checker.
- Partial score và checker exit code mapping.
- UTF-8, invalid UTF-8, CRLF, trailing spaces, empty output, binary output và output lớn.
- Stdin/stdout và file I/O.

## 10. Các phase triển khai và cổng thoát

### Phase 0 — Chốt contract và spike rủi ro

Không thêm ngôn ngữ vào UI.

Việc làm:

- Ghi decision log D1–D15 và amendment D15 đã duyệt.
- Lập provider/version-policy matrix cho local discovery của C++/Python hiện tại và từng profile dự kiến; audit legacy `GCC >= 9.2` thay vì mặc định tái sử dụng.
- Prototype passive detector, candidate identity và local-certified snapshot trên Windows; thiết kế cùng fixture/command để chạy lại trên macOS khi có máy.
- Tạo corpus conformance chung và benchmark fixtures.
- Tái hiện hai nghi vấn OLE/cumulative write.
- Spike FPC trên Windows sạch và macOS ARM64 sạch.
- Spike Go compiler subprocess/cache trong sandbox.
- Spike Java/Node/.NET JIT, memory/thread và Seatbelt/AppContainer.
- Spike Rust linker Windows GNU/MSVC và macOS SDK.
- Ghi nguồn, license, minimum OS và kích thước installed thực tế của từng package.
- Chạy corpus C với `c11`/`c17`/`gnu17` trên GCC và Apple Clang.
- Đo aggregate CPU/wall-time với chương trình đa luồng hiện tại trên Windows/macOS và chốt hướng D12.
- Inspect PE/Mach-O dependency closure và platform prerequisite trên binary thật; hoàn tất redistribution notice matrix cho đúng artifacts.
- Lập bảng UTF-8/verdict cho từng checker và historical-corpus baseline trước mọi sửa semantics.

Cổng thoát:

- Có decision log đã duyệt.
- Có kết quả pass/fail tái lập được cho từng spike.
- Không dùng tuyên bố “hỗ trợ” dựa trên source inspection.

### Phase 1 — Foundation, giữ kết quả cho contest hợp lệ/không mơ hồ

Việc làm:

- `LanguageProfile` registry cho đúng C++/Python hiện tại.
- Exhaustive dispatch, bỏ mọi “else = Python”.
- Deterministic discovery và ambiguity error.
- Toolchain state/API/UI/metadata dạng map có migration.
- Selection schema v2: `none | managed | local_path | local_auto`; readiness/capability được server suy ra, không fallback.
- Toolchain Manager C++/Python theo bảng/radio/status/actions D15; local auto-detect chỉ passive-discover cho đến khi Verify/Certify.
- Atomic selection/path API, reason codes ổn định, ambiguity UI và migration idempotent từ preferences v1.
- `PreparedProgram`/artifact abstraction nhưng adapter cũ vẫn cho kết quả như trước.
- Preflight capability.
- Test regression Reload giữ selection.
- Snapshot và so sánh executor request C++/Python trước/sau refactor: executable, argv, env, limits, role và artifact—not chỉ verdict cuối.

Thay đổi hành vi có chủ ý phải được version/document riêng: source trùng basename chuyển từ “chọn file đầu tiên” sang ambiguity error; thiếu capability được báo ở preflight thay vì fail muộn; API/UI toolchain chuyển sang map nhưng có compatibility adapter.

Cổng thoát:

- Toàn bộ test C++/Python hiện có pass.
- Stress/release gates C++/Python không đổi kết quả.
- Historical corpus hợp lệ/không mơ hồ không đổi executor request hoặc verdict ngoài danh sách thay đổi đã duyệt.
- Archive/preferences cũ mở được và không mất dữ liệu.
- Không có ngôn ngữ mới được bật bằng feature flag.

### Phase 2A — Executor/package hardening cho native wave

Việc làm:

- Manifest v2 và content-addressed package cache.
- Capability theo role/package, exact ACL/Seatbelt roots.
- Local certification certificate, snapshot/lease, drift detection và probe role; managed package dùng cùng health/sandbox gate.
- Native artifact cùng declared runtime companions; dependency-closure inspection.
- Per-profile resource policy.
- Nếu Phase 0 xác nhận lỗi OLE/write quota: viết policy/version riêng, chạy historical-corpus diff và xin duyệt thay đổi verdict trước khi sửa; không gộp như hardening vô hình.
- Offline package import/export và corrupt-package handling.
- Platform packaging gate: executable bit và dynamic-library roots trên macOS; code-signing/quarantine/Gatekeeper behavior; ACL, Defender/file locking và long paths trên Windows.
- Tách khóa/chính sách ký language pack khỏi Tauri updater signing; ghi quy trình rotate/revoke package key.

Cổng thoát:

- Cross-toolchain execution denial test pass ở hai OS.
- Network/process/filesystem escape tests pass.
- Package bị cắt/đổi hash, link escape/cycle, reparse target bên ngoài và archive bomb bị từ chối; internal SDK links đã ký/canonicalize được test riêng.
- C++/Python packaged gates vẫn pass.

### Phase 2B — Directory/managed artifacts, chỉ chặn Java/.NET wave

Việc làm:

- Generic multi-file artifact validation và tree cache.
- Java class directory/JDK-JRE capability split.
- .NET managed bundle/runtime capability split.
- Limits về file count/tree depth/total bytes và dynamic dependency closure.

Cổng thoát:

- Corrupt/escape/missing-entrypoint bundle fail-closed.
- Submission chỉ load selected runtime + verified OS roots, không load user/global package store.
- C++/Python/native wave không bị buộc chờ Phase 2B nếu không dùng directory artifact.

### Phase 3 — Wave 1 product: C, rồi Pascal độc lập

Việc làm:

- C adapter dùng toolchain hiện có.
- FPC package/adapter với config roots được pin.
- Test dialect, `Extended`, integer overflow/range, recursion/stack và file I/O.
- Hiển thị download/minimum-OS trước khi cài Pascal pack.

Cổng thoát:

- C có cổng riêng và có thể Stable/phát hành ngay khi full conformance, resource và packaged release gate của C pass.
- Pascal có cổng riêng; thất bại FPC/macOS không giữ C lại.
- Mỗi profile pass full conformance matrix trên Windows x64 và macOS ARM64.
- Benchmark không phá baseline máy thấp; không cần mạng hay package bên ngoài trong batch.
- Pascal chỉ được Stable nếu linker/toolchain chạy trên máy sạch theo hướng dẫn dành cho giáo viên.

### Phase 4 — Wave 2: Go, Java và Rust

Nên triển khai tuần tự, mỗi adapter có PR và feature flag riêng. Go có thể bắt đầu ngay sau Phase 2A và không phải chờ Pascal; Java chỉ bắt đầu sau Phase 2B; Rust chờ linker spike nhưng không phụ thuộc Java.

- Go: standard library/offline/CGO-off, cache workspace riêng.
- Java: `Main` contract, class-directory artifact, compiler/runtime split, JIT/RSS calibration.
- Rust: `rustc` single-file/std only, linker strategy đã chọn từ spike.

Cổng thoát cho từng ngôn ngữ:

- Conformance/security/checker matrix riêng pass ở hai OS.
- Toolchain health probe và offline install pass.
- Resource factor/allowance được benchmark và ghi metadata.
- Chỉ profile đạt gate mới hiện nhãn Stable.

### Phase 5 — Wave 3: Node.js và C#/.NET

- Node CommonJS single-file trước; không npm/addons.
- C# dùng project/bundle do JudgeDesk kiểm soát, restore/build hoàn toàn offline.
- Đo JIT, helper threads, runtime RSS, cancellation và artifact disk footprint.

Cổng thoát tương tự Phase 4, cộng kiểm thử managed/JIT-specific và không cho load module/assembly ngoài allowlist.

### Phase 6 — Optional/experimental

- Ruby và Haskell chỉ dưới dạng gói tùy chọn sau khi chứng minh supply chain, dung lượng và resource envelope phù hợp.
- Cangjie chỉ Experimental; không dùng mặc định cho kỳ thi chính thức cho đến khi qua toàn bộ gate như ngôn ngữ Stable.

### Phase 7 — Release gate lặp lại sau mỗi profile/wave

Đây không phải một bước bị trì hoãn đến sau Optional/Experimental. Mỗi profile muốn chuyển sang Stable phải chạy Phase 7 ngay ở cuối wave của chính nó:

- Test source-level trong CI.
- Test đúng MSI release candidate trên Windows.
- Test đúng signed/ad-hoc DMG release candidate theo chính sách phát hành macOS hiện hành.
- Offline room rehearsal: máy sạch, import pack, mở archive, preflight, chấm batch, export kết quả.
- Upgrade/downgrade test với contest chỉ C++/Python và contest có profile mới.

### Chiến lược khi máy Mac không luôn sẵn

- Không giữ toàn bộ công việc Windows/type/API/UI chờ máy Mac, nhưng mọi mục macOS chưa chạy được giữ trạng thái `pending-runtime-evidence`, không được ghi pass.
- Trước khi cần máy Mac, branch phải có sẵn fixture, script, expected-output schema và một checklist chạy gộp; không yêu cầu người dùng thử thủ công từng thay đổi nhỏ.
- Ưu tiên CI/Codemagic Apple Silicon cho source/integration gates khi khả dụng. Exact packaged DMG, Gatekeeper/Seatbelt, local-toolchain discovery và baseline tài nguyên vẫn cần Apple Silicon thật đại diện.
- Gom kiểm thử thủ công thành checkpoint: foundation regression; local Apple Clang certification; từng language profile; release candidate. Mỗi checkpoint xuất một evidence bundle để phân tích offline trên Windows.
- Nếu cuộc trò chuyện bị gián đoạn, decision log, branch, plan, test outputs và pending Mac checklist trong repo là nguồn tiếp tục; không dựa vào việc nhớ miệng rằng một gate đã chạy.

## 11. Ma trận test tối thiểu cho từng profile

### 11.1. Correctness

- AC, WA, CE, RE, TLE, MLE, OLE.
- Exit code/signal/exception/panic.
- Empty input/output; EOF không newline.
- Unicode source/path; tên thư mục có dấu và khoảng trắng.
- CRLF/LF; UTF-8; output binary.
- Stdin/stdout và file I/O.
- Nhiều testcase liên tiếp không rò state.
- Compile cache hit/miss/corruption.

### 11.2. Language-specific

- C/C++: stack, undefined behavior fixture chỉ dùng để xác minh classification, không đòi bit-identical output.
- Pascal: dialect, `Extended`, range/overflow switches, file naming/case.
- Go: goroutine, GC, `os/exec` denial, cache/toolchain auto-download denial.
- Java: public class/filename, classpath escape, JVM options injection, heap vs total RSS.
- Rust: panic, stack, linker/toolchain dependency, no Cargo.
- Node: worker/child process/network denial, module/global path escape, V8 heap vs RSS.
- C#: assembly load, child process/network, MSBuild/NuGet/`Directory.Build.*` escape.
- Ruby/Haskell/Cangjie: runtime/package path and subprocess behavior tương ứng.

### 11.3. Sandbox/adversarial

- Đọc file ngoài workspace.
- Ghi ngoài workspace.
- Symlink/junction/reparse escape.
- Spawn child/grandchild; orphan sau timeout/cancel.
- Network DNS/TCP/HTTP.
- Fork/thread/process bomb.
- Ghi-xóa file lặp, tạo nhiều file, output pipe và output file lớn.
- Thử chạy compiler/runtime của package khác.
- Env injection và user home/config/cache poisoning.
- Compiler bomb và artifact archive bomb.
- Package mutation/replacement sau verify và giữa batch; ACL/capability race khi hai role chạy gần nhau.

### 11.4. UI/persistence

- Discovery mỗi extension.
- Hai source cùng basename.
- Reload giữ check state và lựa chọn source.
- Missing/unsupported/corrupt toolchain.
- Preflight nhiều lỗi trong một lần.
- Contest archive save/open/upgrade.
- Excel/export metadata với map toolchain.
- UI tiếng Việt và tiếng Anh.

## 12. Trải nghiệm cài đặt được đề xuất

Toolchain Manager hiển thị theo nhu cầu contest:

- Một hàng/card cho mỗi language profile được app hỗ trợ.
- Status: `Not available`, `Checker only` hoặc `Submission ready`; kèm reason/diagnostics, version, path, target, OS/arch và health check gần nhất.
- Radio source: `None`, `Managed by toolchain`, `Local (path)`, `Local (auto-detect)`.
- Actions theo ngữ cảnh: `Download and apply for JudgeDesk`, `Repair/Reinstall`, `Uninstall` (managed only), `Browse…`, `Rescan`, `Diagnostics`.
- Managed package hiển thị download size, installed size, minimum OS và license.
- Profile/package không hỗ trợ hiển thị lý do cụ thể; profile Experimental có cảnh báo không dùng cho kỳ thi chính thức.

Radio là ý định cố định của người dùng. Server chỉ resolve đúng source đã chọn; không fallback Managed → Local hoặc Local → Managed. `Installed`, `Detected`, `Selected` và `Ready` là bốn trạng thái khác nhau. Ví dụ package có thể đã cài nhưng radio là `None`: status vẫn `Not available`, phụ chú `Installed but disabled`.

Luồng:

1. Người dùng mở contest/thư mục.
2. JudgeDesk discovery source và checker.
3. Toolchain Manager hiển thị các local candidates đã phát hiện nhanh và tiến trình certification.
4. Người dùng giữ local candidate đạt chuẩn hoặc tải/import managed package.
5. “Kiểm tra sẵn sàng” lập danh sách chính xác profile/capability còn thiếu.
6. Health + sandbox probe compile-run bằng đúng recipe.
7. Judge session khóa managed digest hoặc certified-local/platform fingerprint cho toàn batch.
8. Export ghi lại môi trường đã dùng.

Không bắt người dùng cài JDK, Go, Rust, .NET, GHC cùng lúc nếu contest không dùng chúng.

## 13. Migration, rollout và rollback

- Giữ C++/Python làm profile Stable mặc định trong suốt migration.
- Source support đơn thuần không buộc tăng contest `formatVersion`; metadata mới thêm theo hướng additive và reader cũ phải được test.
- Trong ít nhất một chu kỳ tương thích, export/metadata mới vẫn đọc được các field C++/Python cũ.
- Mỗi profile có feature flag/status độc lập. Có thể tắt profile lỗi mà không làm hỏng archive hoặc kết quả đã lưu.
- Package có thể rollback về version đã pin; không thay package giữa batch.
- Không đổi semantics checker cùng lúc với việc bật một ngôn ngữ nếu thay đổi đó không có test/migration độc lập.

## 14. Chiến lược branch

Branch nền tảng đã tạo: `judgedesk/language-runtime-foundation`.

Sau khi chốt quyết định:

1. `judgedesk/language-runtime-foundation` — chỉ refactor C++/Python, migration và test.
2. Sau khi foundation/Phase 2A merge: `judgedesk/language-c`.
3. Pascal độc lập: `judgedesk/language-pascal`; có thể dừng ở spike mà không giữ C lại.
4. Các branch ngắn tuần tự tiếp theo: `judgedesk/language-go`, `judgedesk/language-java`, `judgedesk/language-rust`.
5. Managed/JIT branch riêng sau đó: `judgedesk/language-node` và `judgedesk/language-dotnet`.
6. Experimental profile không đi chung PR với core Stable.

Không mở nhiều branch cùng sửa registry/executor trước khi foundation merge; làm vậy tăng xung đột và khiến security review khó xác định.

## 15. Các quyết định cần chốt trước khi code

### D1. Wave Stable đầu tiên

**Đề xuất:** milestone sản phẩm ưu tiên C và Pascal, nhưng C là profile/release độc lập đầu tiên; Pascal chỉ theo sau khi spike FPC qua gate. Go là track kỹ thuật kế tiếp và có thể tiến hành sau Phase 2A mà không chờ Pascal.

Không gộp C + Pascal + Go thành một cổng Stable duy nhất; một toolchain khó không được giữ các profile đã sẵn sàng lại.

### D2. Chính sách source

**Đề xuất:** chế độ thi chính thức chỉ nhận source, single-file và standard/core library. Từ chối `.exe`, `.class`, `.jar`, DLL và project tùy ý.

Nếu cần tương thích legacy artifact, phải thiết kế một “trusted precompiled mode” tách biệt, không bật mặc định và không gọi là chấm tái lập.

### D3. C standard và extension alias

**Đề xuất tạm thời:** dùng `.c`, đưa `c11` (đúng ảnh Themis), `c17` và `gnu17` qua corpus bài C thực tế trên GCC/Apple Clang rồi mới khóa default. `gnu17` thuận tiện cho GNU extensions phổ biến nhưng có thể giảm parity; strict `c11/c17` dễ mô tả hơn. Không khẳng định code Themis cũ sẽ hỏng nếu chưa chạy corpus.

Có thể nhận `.cc`/`.cxx` như alias C++ nhưng ambiguity phải yêu cầu chọn rõ.

### D4. Java entry point

**Đề xuất:** yêu cầu `public class Main`, không có `package`; JudgeDesk stage source thành `Main.java` mà không sửa nội dung. Source/bytecode level phải pin bằng `--release` theo toolchain profile; chưa chốt Java 21 chỉ từ kế hoạch này.

Phương án tương thích tên bài: class public theo problem ID; khó dùng lại source từ online judge và phức tạp hơn khi problem ID có ký tự không hợp lệ.

### D5. Toolchain distribution

**Đề xuất:** pack tùy chọn, signed/hashed, tải trước hoặc import offline; installer chính chỉ giữ thành phần cốt lõi hiện có.

Bundle tất cả sẽ đơn giản hóa một lần click nhưng tăng mạnh download, disk, attack surface và thời gian update.

### D6. TLE/MLE theo ngôn ngữ

**Đề xuất:** cho phép profile có time factor/startup allowance và explicit language memory allowance/factor, nhưng chỉ sau benchmark; luôn hiển thị công thức, requested/effective values và ghi metadata. Submission dùng được toàn bộ effective memory limit; JudgeDesk không tuyên bố tách riêng phần runtime. Không có multiplier ẩn theo OS.

Phương án dùng cùng raw limit cho mọi ngôn ngữ dễ hiểu hơn nhưng có thể bất công với JVM/.NET/Node/Ruby và không phản ánh startup/runtime overhead.

### D7. Minimum OS

**Đề xuất:** không nâng minimum OS của toàn app chỉ vì một pack. Mỗi profile/package khai báo minimum OS; máy thấp hơn vẫn dùng JudgeDesk và các ngôn ngữ tương thích.

Ví dụ toolchain upstream mới có thể yêu cầu macOS cao hơn baseline app; khi đó pin một version còn được hỗ trợ hoặc đánh dấu profile unavailable, không tải rồi mới fail.

### D8. Checker scope

**Quyết định đã duyệt:** đợt đầu UI/discovery custom checker vẫn chỉ C++/Python; mọi ngôn ngữ submission dùng chung checker matrix. Security contract đã tổng quát cho mọi checker: ngôn ngữ biên dịch tương lai đi theo pipeline C++ (`compiler` rồi artifact `checker`); checker cần runtime đi qua typed `checker-runtime` chỉ sau snapshot/certification. Không có host exception hoặc fallback khi sandbox không tương thích.

Mở checker theo toàn bộ ngôn ngữ sẽ nhân đôi bề mặt toolchain/sandbox mà không mang nhiều giá trị cho kỳ thi đầu tiên.

### D9. Text encoding

**Đề xuất:** contract text output là UTF-8 với locale/dấu thập phân xác định; byte-exact giữ raw bytes. Answer text invalid UTF-8 là lỗi đề. Với output thí sinh invalid UTF-8, Phase 0 phải chốt bảng verdict cho từng C1–C4/Polygon checker trước khi đổi decoder; không dùng một mapping WA/PE chung mơ hồ.

Thay đổi này phải có regression riêng vì decoder hiện tại có thể thay byte UTF-8 lỗi bằng replacement character.

### D10. Bỏ qua

D10 không còn là decision/blocker. Ruby, Haskell và Cangjie nằm ngoài roadmap triển khai hiện tại; bảng đánh giá của tài liệu chỉ được giữ làm thông tin tham khảo, không tạo cam kết release.

### D11. Baseline phần cứng

**Đề xuất đã chốt single-instance:** tiếp tục tối ưu cho Windows x64 8 GB và Apple Silicon 8 GB. JudgeDesk không chạy nhiều app instance hoặc nhiều batch đồng thời; compiler/run/checker vẫn phải tuân thủ resource gate của phiên duy nhất.

Nếu kỳ thi mục tiêu có baseline thấp hơn, cần cung cấp máy mẫu trước Phase 0 để benchmark đúng.

### D12. Công bằng CPU Windows/macOS

**Đề xuất:** Phase 0 phải đo và thiết kế tổng CPU-time budget cho toàn process tree, đi cùng wall-time cap; runtime concurrency flags chỉ là policy bổ trợ đã benchmark, không phải cơ chế bảo vệ. Profile có code đa luồng không được Stable nếu Windows vẫn bị khóa một CPU còn macOS có thể dùng nhiều core mà sự khác biệt chưa được enforce hoặc công khai chấp nhận.

Nếu chưa thể có aggregate CPU enforcement đáng tin trên cả hai OS, phải ghi rõ giới hạn parity và giữ profile chịu ảnh hưởng ở Experimental thay vì che bằng hệ số OS.

### D13. Sửa semantics OLE/write/UTF-8 hiện có

**Đề xuất:** cho phép điều tra trong foundation, nhưng mỗi thay đổi verdict phải có policy version, historical-corpus diff và phê duyệt riêng. Không ghép một sửa semantics checker/executor vào PR bật ngôn ngữ mới.

### D14. Apple platform toolchain và prerequisite

**Đề xuất:** tiếp tục dùng mô hình `platform-certified` cho Apple Clang/SDK thay vì hứa byte-for-byte reproducibility như managed package. Metadata phải ghi compiler build/version, selected SDK version/build/path identity và profile allowlist; Stable gate chạy trên đúng tổ hợp đã chứng nhận. Managed Clang không tự giải quyết quyền phân phối Apple SDK.

FPC/GHC hoặc linker khác cần Command Line Tools phải báo prerequisite ở preflight với hướng dẫn một lần. Pascal chỉ Stable nếu prerequisite này được chấp nhận và UX trên máy giáo viên sạch đạt gate; nếu yêu cầu pack hoàn toàn self-contained, Pascal chờ đến khi chứng minh được phương án hợp pháp/kỹ thuật.

### D15. Toolchain nào được phép chấm và preflight chặn ở đâu

**Amendment đã duyệt:** JudgeDesk cho phép dùng cả managed toolchain và local toolchain đạt chuẩn. `Local` không bị giới hạn vĩnh viễn ở Checker only; nó được nâng lên Submission ready khi thỏa toàn bộ policy của đúng language profile/OS/architecture.

#### D15.1. Source selection

Mỗi language profile có đúng một lựa chọn đang active:

- `None`: tắt profile trên máy này. JudgeDesk không tự fallback sang source khác.
- `Managed by toolchain`: package do JudgeDesk tải/import, verify và quản lý.
- `Local (path)`: executable/root do người dùng chọn rõ.
- `Local (auto-detect)`: candidate do JudgeDesk tìm từ PATH và các vị trí chuẩn.

`Local (path)` và `Local (auto-detect)` dùng chung certification pipeline; khác nhau ở cách tìm candidate. UI dùng radio group như yêu cầu. Nếu một lựa chọn không tồn tại trên OS/profile, radio bị disable và hiển thị lý do.

Radio là ý định cố định: resolver không fallback sang source khác. Candidate/path biến mất chỉ làm source đã chọn chuyển thành Not available và giữ nguyên lựa chọn để người dùng sửa hoặc rescan.

#### D15.2. Readiness status

Backend lưu capability theo role; UI hiển thị trạng thái cao nhất cùng lý do:

- `Not available / Không tìm thấy`: `None`, không có candidate, executable lỗi, version/target ngoài policy, thiếu support roots/linker/runtime, hoặc probe thất bại.
- `Checker only / Chỉ dùng để dịch máy chấm`: candidate đã có immutable snapshot/certification đủ cho checker role nhưng chưa đạt submission sandbox policy. Trạng thái này chỉ có ý nghĩa cho profile được phép viết checker trong D8; local/system runtime chỉ được auto-detect nhưng chưa snapshot/chứng nhận hiện phải là Not available, không được gắn nhãn Checker only.
- `Submission ready / Sẵn sàng chấm`: đúng compiler/runtime identity, version policy, target/architecture, support roots, compile-run health probe và sandbox certification.

`Submission ready` không được suy ra chỉ từ `--version`. Tương tự, local compiler không bị hạ xuống Checker only chỉ vì không phải managed; kết luận phụ thuộc bằng chứng certification.

#### D15.3. Fast detection khi mở app

Detection chạy bất đồng bộ để không chặn cửa sổ chính:

1. Ưu tiên path đã lưu và managed store.
2. Kiểm tra PATH bằng API không qua shell.
3. Kiểm tra danh sách vị trí chuẩn có giới hạn:
   - Windows: App Paths/Uninstall registry khi phù hợp, `Program Files` vendor roots, Code::Blocks/MinGW/MSYS2/Java/.NET/Go/Rust locations đã khai báo theo profile.
   - macOS: `xcrun` cho Apple toolchain, `/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `/Library/Java/JavaVirtualMachines` và các vendor roots đã khai báo.
4. Không recursive-scan toàn ổ đĩa, home hay mọi thư mục trong `Program Files`.
5. Candidate được canonicalize/deduplicate; symlink/reparse target và architecture được kiểm tra trước khi probe.

Fast discovery không tự chạy mọi binary vừa tìm thấy. UI có thể hiện `Detected — verify to use`; đây là phụ chú/transient state, còn readiness vẫn Not available cho đến khi candidate được người dùng chọn hoặc đã có certificate cũ để quick-revalidate. Identity/version probe có timeout/output cap và chạy bằng probe role; không chạy tùy ý trên host.

Quyết định đã chốt: lần mở đầu chỉ chạy fast discovery nói trên. Full certification/snapshot cần thao tác rõ ràng của người dùng; certificate cũ chỉ được quick-revalidate theo identity/policy đã pin.

Auto-detect fail-closed:

- Không có candidate tương thích: `AUTO_DETECT_NOT_FOUND`.
- Có đúng một canonical candidate đạt discovery policy: tiếp tục certification.
- Có nhiều canonical candidates: `AUTO_DETECT_AMBIGUOUS`; UI liệt kê path/version/reason, không tự chọn theo PATH hay version cao nhất.
- Khi người dùng chọn một candidate trong danh sách, selection chuyển rõ ràng thành `Local (path)`.
- Candidate bị loại vẫn có thể hiện trong Diagnostics cùng reason code; không được coi là ready.

#### D15.4. Version và certification policy

Mỗi profile/version của JudgeDesk khai báo:

- Compiler/runtime family và executable names hợp lệ.
- Version rule tường minh: `exactAllowlist` hoặc `boundedRange { minInclusive, maxExclusive, testedMajors }`; exact entry pin family/distributor/version/build + identity policy, còn candidate fingerprint thuộc certificate; không dùng một minimum mở vô hạn cho mọi future major.
- Host OS/architecture và target triple hợp lệ.
- Required compiler/linker/runtime/support roots.
- Version parser, compile recipe và deterministic environment.
- Checker/submission role eligibility.
- Health fixtures và sandbox probe version.

Policy snapshot sơ bộ ngày 2026-07-28 — đây là candidate để Phase 0 kiểm chứng, chưa phải allowlist đã phát hành:

| Profile | Candidate version policy ban đầu | Ghi chú bắt buộc |
|---|---|---|
| C/C++ Windows | GCC 9.2 chỉ là legacy audit fixture; regression-test chính xác legacy 9.2 và managed 14.2 trước khi chọn supported floor/range mới | Chứng nhận distributor/build, exact `x86_64-w64-mingw32` target, UCRT/MSVCRT, thread model, exception model, binutils/linker và runtime-DLL closure; không dùng `>=9.2` mở vô hạn |
| C/C++ macOS | Không so Apple Clang như LLVM semver; allowlist compiler build + developer root + SDK identity | Native ARM64/universal ARM64 slice; platform-certified |
| Python | Managed JudgeDesk build 3.12.13 là baseline; local submission candidate phải khớp exact CPython build/ABI/stdlib allowlist, không phải mọi bản 3.12 | Upstream 3.12.13 là source-only security release và 3.12.10 là bản cuối có binary installer; không tự nhận PyPy/Conda/pyenv chỉ từ version |
| Pascal | FPC 3.2.2 exact stable | 3.3.x là development snapshot; target/units/linker/CLT phải đúng |
| Go | Snapshot khảo sát: exact Go 1.25.12 và 1.26.5; ưu tiên spike 1.26.5, không ghi động “latest patch” vào profile | `GOTOOLCHAIN=local`; Windows 10+/amd64, macOS 12+/arm64; update profile phải qua corpus lại |
| Java | Hai candidate riêng: exact JDK 21 runtime profile và exact JDK 25 runtime profile; cả hai có thể đánh giá recipe `--release 21` | `java` và `javac` cùng JDK/vendor/build; JDK 25 chạy class target 21 vẫn là runtime khác, phải benchmark/certify riêng |
| Rust | Snapshot khảo sát: exact stable Rust 1.97.1; không beta/nightly và không tự roll sang stable mới | Chốt edition, host/target, linker và standard-library closure trước khi đặt floor/range |
| Node.js | Snapshot khảo sát: exact Node 24.18.0, không dùng nhãn động “latest security patch” trong profile | Windows 10+/x64; macOS 13.5+/arm64 theo tài liệu của tag 24.18.0; JIT/ICU probe |
| C#/.NET | Candidate .NET 10 LTS; exact SDK feature band/patch, runtime patch, targeting pack và RID chưa chốt cho đến spike Phase 0 | `net10.0`; `global.json`/SDK search root phải pin và không roll ngoài policy; win-x64, macOS 14+/osx-arm64 |

Nguồn policy chính: [Go release history](https://go.dev/doc/devel/release), [Python 3.12.13 release](https://www.python.org/downloads/release/python-31213/), [FPC stable downloads](https://docs.freepascal.org/download.html), [OpenJDK 25](https://openjdk.org/projects/jdk/25/), [`javac --release` JDK 21](https://docs.oracle.com/en/java/javase/21/docs/specs/man/javac.html), [Rust release announcements](https://blog.rust-lang.org/releases/), [Node 24.18.0 archive](https://nodejs.org/download/release/v24.18.0/), [Node 24.18.0 platform matrix](https://github.com/nodejs/node/blob/v24.18.0/BUILDING.md), [MSYS2 environments](https://www.msys2.org/docs/environments/), [.NET lifecycle](https://learn.microsoft.com/en-us/lifecycle/products/microsoft-net-and-net-core), [.NET `global.json`](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json) và [.NET macOS support](https://learn.microsoft.com/en-us/dotnet/core/install/macos).

Candidate chỉ là Submission ready khi:

1. Canonical executable đúng family và host architecture.
2. Version nằm trong range JudgeDesk đã chứng nhận; version mới hơn nhưng ngoài tested policy vẫn là detected/unsupported, không tự được nâng hạng.
3. Target, linker, standard library/runtime và dynamic dependencies đầy đủ.
4. Compile fixture và run fixture pass bằng đúng argv/env sẽ dùng khi chấm.
5. Submission sandbox pass network/filesystem/process/resource probes cho exact executable/support roots.
6. Fingerprint không đổi.

Không dùng WOW64/Rosetta cho profile Stable. Managed package cũng phải qua health/sandbox probe; hash chỉ chứng minh identity, không chứng minh package chạy đúng trên máy.

Local certification có hai deployment mode:

- `platform-certified direct`: chỉ dành cho platform toolchain có policy riêng, như Apple Clang + selected developer root + SDK identity.
- `local-certified snapshot`: mặc định cho GCC/JDK/runtime và local toolchain khác. JudgeDesk tính dependency/support-root closure, hiển thị dung lượng, rồi import một snapshot immutable vào content-addressed executor cache. Radio/provenance vẫn là Local; app không giả nó là package đã tải.

Chỉ cho chạy trực tiếp từ local installation root khi profile chứng minh root/capability bất biến và exact sandbox closure pass. Nếu toolchain không relocatable/snapshot được hoặc sandbox probe fail, UI đề nghị managed pack; không mở ACL/Seatbelt cho cả installation tree để “làm cho chạy”.

Local snapshot chỉ dùng trên máy đã chứng nhận và không được export như language pack. Nếu cho phép chuyển snapshot sang máy khác, nó trở thành distribution package và phải qua lại license/notices/signing gates của manifest v2.

Certificate tối thiểu gồm profile/role, canonical executable, file identity/SHA-256, family/version/build/architecture, helper executables, support roots/SDK/dynamic dependency closure, recipe digest, snapshot digest hoặc platform identity, executor/sandbox/probe-suite version và kết quả probe.

Fingerprint tối thiểu gồm canonical path, file identity, size/mtime, executable hash khi khả thi, parsed version, target và support-root identity. JudgeDesk cache kết quả để mở nhanh nhưng revalidate ở startup, khi đổi radio/path, trước batch và khi fingerprint thay đổi. Batch pin certificate bằng lease; toolchain bị update/thay giữa batch làm fail-closed.

Version floor cụ thể của từng ngôn ngữ được chốt trong Phase 0 bằng tài liệu upstream và corpus, không hard-code từ một chuỗi locale. Ví dụ `GCC >= 9.2` hiện có trong thông báo C++ chỉ là legacy policy cần audit, không tự trở thành chuẩn chung.

#### D15.5. Actions

- `Download and apply for JudgeDesk`: đây là hành động kết hợp do người dùng chủ động yêu cầu; tải/import managed package, verify, chạy health probe và chỉ chọn `Managed by toolchain` sau khi thành công. Không đổi radio nếu install/probe thất bại.
- Download/apply phải pin preference revision và intent lúc bắt đầu. Nếu người dùng đổi radio trong khi đang tải, package có thể hoàn tất cài đặt nhưng không được ghi đè lựa chọn mới; UI báo `Installed, not applied`.
- `Uninstall`: chỉ hiện với managed package. Không bao giờ xóa local compiler/runtime.
- Managed package đang được batch/contest pin không được uninstall. Với package không còn active, uninstall cần confirm; nếu radio đang là Managed thì giữ nguyên radio nhưng status chuyển thành Not available và hiện nút Download, tuyệt đối không fallback sang local.
- `Browse… / Verify & use` chỉ áp dụng cho `Local (path)` và cập nhật path + selection atomically sau khi identity validation tối thiểu pass.
- `Certify for judging` tính closure/snapshot nếu cần, hiển thị disk impact, rồi chạy full executor probe. Với local candidate chỉ cần checker, UI có thể dừng ở Checker only.
- `Rescan` chạy lại detection có giới hạn cho `Local (auto-detect)`.
- `Diagnostics` hiển thị path, version, target, capability theo role và bước certification nào fail.

Reason codes ổn định tối thiểu: `DISABLED_BY_USER`, `MANAGED_PACKAGE_UNSUPPORTED`, `MANAGED_PACKAGE_NOT_INSTALLED`, `MANAGED_PACKAGE_CORRUPT`, `HEALTH_CHECK_FAILED`, `LOCAL_PATH_REQUIRED`, `LOCAL_PATH_MISSING`, `LOCAL_EXECUTABLE_INVALID`, `LOCAL_VERSION_UNSUPPORTED`, `LOCAL_NOT_SANDBOX_COMPATIBLE`, `AUTO_DETECT_NOT_FOUND` và `AUTO_DETECT_AMBIGUOUS`.

#### D15.6. Preflight semantics

Với selected scope còn thiếu Submission ready capability, nút bắt đầu batch bị chặn cho đến khi người dùng `Certify local`, cài managed pack hoặc bỏ chọn phần bị ảnh hưởng. Preflight không tin cache TTL: quick-verify certificate và chạy lightweight end-to-end sandbox probe trước batch đầu tiên của app session; full certification chạy lại khi identity/policy thay đổi.

PATH thay đổi chỉ tạo candidate mới, không thay source/certificate đã pin. Update/uninstall bị chặn trong batch lease. Drift trước batch là configuration/preflight error; drift giữa batch là JE cho phần bị ảnh hưởng, không phải CE của thí sinh. Checker dependency thiếu chỉ chặn/đánh dấu problem liên quan như mục 9.

Phase 1 không retroactively vô hiệu custom C++ path hiện có. Preferences cũ được migrate:

- `preferredSource*=managed` → `Managed by toolchain`.
- `preferredSource*=custom` + path → `Local (path)`.
- `preferredSource*=custom` nhưng path thiếu/rỗng → vẫn giữ intent `Local (path)`, status Not available với `LOCAL_PATH_REQUIRED`; không fallback.
- `preferredSource*=system` → `Local (auto-detect)`.
- Custom path cũ luôn được giữ như remembered path khi mode active là Managed/System; dormant path không được probe hoặc dùng cho đến khi người dùng chọn lại và verify.
- Profile mới không có preference → `None`; unknown profile ID được bảo toàn nhưng registry hiện tại bỏ qua. Unknown future schema/corrupt JSON phải dừng ở recovery, không tự ghi đè bằng default.
- Python system/auto hiện tại vẫn Checker only cho đến khi một local-Python submission profile thật sự vượt sandbox certification; không được tự nâng hạng trong migration.
- Preference malformed/không đúng kiểu → `None` kèm migration diagnostic; không đoán source.

Installed package state được kiểm tra từ disk/manifest; `installedToolchains` legacy không còn là nguồn chân lý. Migration phải idempotent; reader giới hạn byte trước parse, decode UTF-8 fatal và không overwrite corrupt/future schema. Writer phải validate canonical v2, dùng revision của exact raw bytes, temp cùng directory + file sync + atomic replace, rồi xử lý durability khác nhau theo OS. Per-write inter-instance lease không thuộc thiết kế đích single-instance; chỉ được loại bỏ sau khi guard đã được đăng ký trước mọi startup mutation và packaged Windows/macOS gate chứng minh secondary không đi vào setup. In-process writer queue, revision/CAS và atomic replace vẫn bắt buộc để chặn stale async update, external file drift và hỏng file khi crash. Vì app cũ không hiểu `None` và có thể fallback, downgrade từ schema mới cần cảnh báo/chặn rõ thay vì dual-write một semantics sai.

### D16. Single-instance và định danh phiên chấm

**Đã duyệt:** JudgeDesk chỉ cho phép một app instance. Mục tiêu là loại bỏ tranh chấp giữa nhiều backend/executor và giữ giới hạn tài nguyên dễ hiểu trên máy giáo viên. Lần mở thứ hai phải kích hoạt lại cửa sổ primary rồi thoát trước khi khởi tạo Tauri/UI/backend của chính nó.

Audit baseline tại `b1ed52f` chưa enforce single-instance: native executors dùng chung root `JudgeDeskExecutor`, startup xóa artifact cache và dùng fixed self-test workspace; Tauri nhả free port trước khi sidecar bind; API local chưa có instance authentication; job ID do client tạo ngắn. Branch foundation hiện đã thêm guard, job UUID/effective-ID registry, cancel barrier `reserved → started → completed` và bounded shutdown handoff; debug Windows gate đã đạt nhưng D16 vẫn chưa được gọi là hoàn tất cho đến khi API identity/session contract cùng packaged Windows/macOS gate vượt đủ. Kiểm tra single-instance phải xảy ra trước backend spawn và trước mọi startup cleanup/mutation, không được chỉ disable nút ở UI.

Contract bắt buộc:

1. `InstanceCoordinator` phải lấy lifetime file lease fail-closed trước cả `tauri::Builder::default()`, bind activation endpoint trên loopback, tạo nonce ngẫu nhiên và publish owner metadata atomically với giới hạn kích thước. Secondary không lấy được lease thì chỉ được đọc metadata, cấp quyền foreground cần thiết trên Windows, gửi authenticated activation request trong timeout hữu hạn và thoát. Primary xử lý request bằng cách show + unminimize + focus cửa sổ chính; chỉ được ghi ACK khi focus callback thành công và coordinator vẫn ở `Ready`. `Starting`/`Draining` phải từ chối để secondary retry. Listener dùng framed I/O, timeout ngắn, hàng đợi và worker count hữu hạn; signaling hỏng không bao giờ cho secondary trở thành primary khi lease còn bị giữ.
2. Trên Windows, Tauri/updater phải ở ngoài private Job Object. Primary lấy provisional `process-tree.lock`, tạo backend-only Job `KILL_ON_JOB_CLOSE`, rồi chạy một internal headless supervisor của cùng executable. Supervisor phải giữ tree lock + Job handle và chỉ trả `READY` trước khi primary publish metadata/start Tauri; backend bị chặn bằng startup gate, được assign vào Job rồi gate mới mở để nó spawn executor. Khi control pipe EOF hoặc có `DRAIN`, supervisor terminate/poll `ActiveProcesses == 0`, chỉ sau đó nhả tree lock và thoát. Trên macOS cấm ambient file-descriptor inheritance; phải có supervisor/process-group ownership explicit và drain barrier tương đương trước khi D16 được coi là đạt. Tauri restart/updater phải chuyển activation sang `Draining`, dừng backend, xác nhận process tree rỗng và helper đã thoát rồi mới nhả instance lease/relaunch. Frontend phải gọi `prepare_for_update` thành công trước `update.install()`; lỗi sau prepare đưa UI vào `restart-required`, không cho quay lại chấm.
3. Primary vẫn tạo `instanceId` ngẫu nhiên 128-bit và `instanceToken`; sidecar handshake trả đúng `{ pid, port, instanceId }`, mọi API kể cả cancel/shutdown xác thực token. Đây là rào chắn chống gọi nhầm backend/local request ngoài app, không phải cơ chế cho multi-instance.
4. Backend tạo `sessionId` UUID; client `requestId` chỉ để correlation. Mỗi event có envelope `{ instanceId, sessionId, sequence, type, data }`, sequence tăng nghiêm ngặt và có đúng một terminal event; UI bỏ event sai/stale identity.
5. `runId` liên kết instance/session/role/UUID và executor client xác nhận response trả đúng run ID. Workspace được tạo exclusive; cleanup chỉ xóa subtree có ownership hợp lệ của instance/session hiện tại. Crash-restart scavenging không được xóa path không chứng minh được owner đã chết.
6. Managed package đang có batch lease không được update/uninstall/purge. Preferences/storage dùng serialized mutation trong primary, revision/CAS và atomic replace; không dựa riêng vào single-instance để che stale async write hay external file drift.
7. Batch pin snapshot đã normalize của problem config, test/submission inventory, toolchain/certificate ngay khi bắt đầu. Thay đổi input/config giữa batch phải bị queue/chặn hoặc báo `INPUT_CHANGED_DURING_JUDGING`, không được âm thầm tạo kết quả lai.

Gate bắt buộc gồm: mở app lần hai và 20 lần liên tiếp trên Windows/macOS; primary đang bình thường, minimized, hidden và busy đều phải được restore/focus trong timeout, secondary thoát sạch và không chạy setup mutation. Sau khi hệ thống ổn định phải có đúng một GUI primary JudgeDesk, đúng một internal supervisor helper của primary trên nền tảng cần nó, không bao giờ quá một backend sidecar và một native executor; không tính WebView/system helper, và executor có thể là 0 nếu startup/health fail. Request sai nonce, quá dài, treo hoặc đến từ endpoint không hợp lệ phải bị từ chối mà listener vẫn phục vụ request sau. Crash primary rồi mở lại không được mắc stale lock; phải chứng minh sidecar/executor cũ đã dừng trước khi primary mới cleanup/spawn. Phải test riêng primary chết, supervisor chết, và double-failure; giới hạn không thể bảo đảm khi đồng thời cưỡng chế chết cả owner lẫn recovery authority phải được fail-closed hoặc công bố rõ, không được ẩn dưới nhãn “verified”. Tauri relaunch và updater install/autolaunch phải được kiểm tra riêng để containment không giết installer hoặc làm replacement mất vì lease chưa nhả. `tauri-plugin-updater` 2.10.1 hiện còn bỏ qua lỗi `ShellExecuteW` trước khi thoát app; chỉ được gỡ blocker phát hành sau khi pin bản official chứa fix và packaged update gate pass. Sai token/session/event phải bị từ chối; edit config/test giữa batch phải fail-closed; packaged app/DMG phải qua gate trên Windows và Apple Silicon thật.

## 16. Definition of Done cho một ngôn ngữ “Stable”

Một ngôn ngữ chỉ được ghi là hỗ trợ ổn định khi:

- Toolchain có nguồn, exact version/build, minimum OS và managed digest, certified platform identity hoặc local certificate rõ. Managed/exported package phải có license notices/SBOM; local-in-place/same-machine snapshot phải có provenance/fingerprint nhưng không bị gán nhầm nghĩa vụ redistribution.
- Với managed/exported package: cài online và import offline pass trên máy sạch. Với local source: detection, certification, drift và recovery pass trên installation được hỗ trợ.
- Health probe pass sau cài.
- Full correctness/checker/security matrix pass ở Windows x64 và macOS ARM64.
- Exact packaged MSI/DMG candidate pass, không chỉ `npm test`/CI.
- TLE/MLE/OLE/process-tree/cancel được xác minh bằng boundary tests lặp.
- Compiler/submission/checker không truy cập mạng, user home, config hay package store ngoài policy. Runtime checker chỉ được chạy từ snapshot/certified toolchain cache; OS loader roots bắt buộc phải được ghi rõ theo nền tảng.
- Metadata/export đủ để giải thích và tái lập run.
- Upgrade/archive/Reload không làm mất lựa chọn hoặc kết quả cũ.
- Resource benchmark đạt baseline máy thấp đã chốt.
- Có hướng dẫn tiếng Việt ngắn cho giáo viên và lỗi có cách khắc phục.
- Có rollback/disable profile mà không phá contest.

## 17. Bước tiếp theo sau khi duyệt

1. [x] Ghi D1–D15 và amendment D15 vào decision log.
2. [x] Tạo branch `judgedesk/language-runtime-foundation`.
3. [x] Khóa current-behavior fixtures cho resolver/preferences/API/executor request C++/Python.
4. [x] Viết typed spec nền cho `LanguageProfile`, selection/readiness/certificate và `PreparedProgram`.
5. [ ] Enforce single-instance trước cleanup/backend spawn; vượt contract test và packaged Windows/macOS secondary-launch/crash-restart gate.
6. [ ] Hoàn tất preferences v2 storage cùng manifest v2 trước khi sửa adapter; migration kernel đã hoàn tất nhưng storage chưa nối live.
7. [ ] Tạo corpus/gates Phase 0 và pending Mac evidence checklist.
8. [ ] Refactor C++/Python theo Phase 1 và chứng minh giữ nguyên executor request/verdict cho corpus hợp lệ, không mơ hồ.
9. [ ] Chỉ sau khi foundation/Phase 2A qua gate mới bắt đầu branch C; Pascal và Go theo gate độc lập đã mô tả.

Không tải toolchain, đổi sandbox hay bật extension mới trước khi current-behavior fixtures và typed contract được review.
