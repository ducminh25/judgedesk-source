# JudgeDesk v1.6.0 — Ubuntu Round 2 Re-UAT

Ngày nghiệm thu: **20/10/2026**, múi giờ **Asia/Bangkok**. Đối chiếu [báo cáo vòng 1](judgedesk-ubuntu-uat-1.6.0-2026-10-20.md). Toàn bộ bằng chứng mới ở [ubuntu-uat-round2-20261020](../../artifacts/ubuntu-uat-round2-20261020/), gồm **126 PNG** và JSON/log/script kiểm chứng. [Danh mục ảnh kèm hash/thời điểm](../../artifacts/ubuntu-uat-round2-20261020/screenshots.json). Ảnh trung gian không mặc nhiên là bằng chứng PASS.

## 1. Tổng quan và kết luận nghiệm thu vòng 2

**Kết luận: CHƯA ĐẠT toàn bộ tiêu chí Round 2.** Các blocker runtime/source-gate của vòng 1 đã được giải quyết trong những phép thử này; còn lỗi P2 mới ở Escape của source preview và thiếu nội dung sandbox trong Help EN. Không phát hiện P0/P1 mới có bằng chứng.

Ma trận UAT-01…12: **8 PASS, 2 FAIL, 2 SKIPPED / ACCEPTED BY DESIGN**. UAT-04 và UAT-09 không tính vào lỗi hoặc blocker. FAIL của UAT-08 là lỗi Escape mới; chức năng preview vốn thiếu ở vòng 1 nay đã hoạt động.

| Chỉ số chính | Kết quả thực tế |
|---|---|
| Cài lại `.deb` mới trước khi mở app | Thành công; hash đúng `e09ede7f…1c3879`; ba binary và hai file Scratch khớp nội dung `.deb` |
| Distribution / compiler | `core`; GCC/G++ 13.3.0, Python 3.12.3 đồng nhất OS/status/active/candidates |
| Scratch đóng gói | 0.1.7, ready ngay; Diagnose PASS; TS12/Scratch **AC 1/1** |
| Scratch execution | UI **0,6440 s / 18,32 MB**; executor wall **644.716 µs**, peak **19.206.144 byte** |
| WA Dark heading | Raster **10,3772:1**, vượt 4,5:1; vòng 1 khoảng 1,41:1 |
| F9 đầy đủ | 8 bài × 12 thí sinh; 26 ô có submission, 70 ô không có; 70 testcase results |
| PARTIAL thật | OSD bổ sung **5/10**, badge sky; có trong ALL/PARTIAL, không có trong INCORRECT |
| Quality gates | Cả 4 lệnh exit **0**; gate Rust thật **9/9 PASS** |
| Server suite | **965 discovered = 955 pass + 10 skipped; 0 fail**; không phải 965 tests đều đã chạy |
| Archive | Workspace trước/mở lại/lưu mới bằng nhau hoàn toàn |
| Excel | ZIP/XML hợp lệ, **20.000 byte**, 3 sheets, 12 thí sinh; actual API `/api/open-excel` HTTP 200 |
| Single-instance / cleanup | Lần hai exit 0 sau **92,559 ms**; 1 cửa sổ; sau X, **4/4 mẫu = 0** tiến trình liên quan |

### Môi trường, bộ cài và phương pháp

- Distro `JudgeDesk-Ubuntu-24.04`: Ubuntu **24.04.5 LTS**, kernel `6.18.33.2-microsoft-standard-WSL2`, amd64; Bubblewrap **0.9.0**. Gói thực tế là **`judge-desk` 1.6.0**, binary `/usr/bin/themis-v2`, `/usr/bin/judgedesk-executor`, `/usr/bin/server`. [Environment](../../artifacts/ubuntu-uat-round2-20261020/environment.json).
- Đã thử `sudo -n dpkg -i …` nhưng tài khoản yêu cầu mật khẩu. Chuyển sang **cùng distro bằng `wsl -u root -- dpkg -i …`**, cài đè thành công **trước khi mở app**; không thay cấu hình sudo. [Lần sudo](../../artifacts/ubuntu-uat-round2-20261020/install-deb.log), [cài thành công](../../artifacts/ubuntu-uat-round2-20261020/install-deb-root.log).
- Hash `.deb`: `e09ede7f32b968a4446ce7e789eb8e21d5a1684f7086ce72eded374faf1c3879`, khác bộ vòng 1 `f0c8eb70…1ffd12d`. RPM khớp hash yêu cầu. AppImage thực tế là **`147c67e0f458f5bd316a92d383a30c6f4119d0f5bc9d2d4320d8c9ed3e5e8824`**, khớp `SHA256SUMS-linux`, khác chuỗi AppImage trong lời nhắn. Không cài/chạy RPM hoặc AppImage trong lượt `.deb` này. [Hash ba installer](../../artifacts/ubuntu-uat-round2-20261020/installer-hashes.json).
- Sau cài, SHA-256 `/usr/bin/themis-v2` là `58cf39bdce6ace0fd436b2a71e83d5f2e0bc14769341e1dc8ba71c1ece568d7b`; executor `651ea8daa0901910ada19cc9b334f6fe261c8c97ccab3ef6d8c980aea9a6791a`; server `0efd37ea96f42637121b38b550ae62f5c6988e3b6f0cf99c9760ef96f6d324c7`. Cả ba khớp file giải nén từ `.deb`. Scratch có đủ `/usr/lib/JudgeDesk/toolchains/scratch-linux-x64/{scratch-run,.judgedesk-package.json}`; receipt version **0.1.7**, file cũng khớp gói. [So sánh installed/package](../../artifacts/ubuntu-uat-round2-20261020/installed-package-comparison.json).
- Đã đọc và khởi tạo skill Computer Use `@oai/sky`. Với WSLg Wayland, helper trả title `[WARN:COPY MODE] JudgeDesk…` nhưng hai lần capture chứa Gemini. Không click/type theo ảnh sai và không lưu ảnh đó vào evidence. Sau retry thất bại, kết thúc riêng phiên QA đó bằng SIGTERM có xác minh executable, khởi động lại cùng binary với **`GDK_BACKEND=x11`** qua **WSLg/XWayland**. GUI sau đó được quan sát bằng GDK screenshot, điều khiển bằng X11/XTest có sẵn; không cài thư viện mới. Không coi kết quả này là bằng chứng helper Computer Use Windows đã hoạt động đúng. [Lý do relaunch](../../artifacts/ubuntu-uat-round2-20261020/launch-x11.json), [controller Linux](../../artifacts/ubuntu-uat-round2-20261020/linux-gui.py), [nhật ký thao tác](../../artifacts/ubuntu-uat-round2-20261020/gui-actions.jsonl).
- Ảnh client app **1908×957**, frame native **1920×990**. Toàn bộ phép thử GUI chính ở XWayland; không đại diện cho Ubuntu GNOME native hoặc mọi backend Wayland.
- `/tmp/judgedesk-uat-contest` không tồn tại sau khi WSL khởi động lại; lần nạp đầu hiện `Directory not found`. Đã tạo lại bằng **script fixture vòng 1**, chỉ đổi đường dẫn ghi manifest sang Round 2: **76 file, 8 bài, 12 thí sinh**; không ghi vào `stress_test_judge` gốc. [Script](../../artifacts/ubuntu-uat-round2-20261020/prepare-fixture.py), [manifest](../../artifacts/ubuntu-uat-round2-20261020/fixture-manifest.json), [8×12 trước F9](../../artifacts/ubuntu-uat-round2-20261020/037-loaded-8x12.png). Đây là fixture gốc được tái tạo, không giữ các chỉnh sửa nháp/config phát sinh trong thao tác vòng 1; vì vậy A_plus_B tối đa **5**, không phải `10/3` của phiên vòng 1.
- Backend thực tế là **Rust core nhúng**, packaged, version 1.6.0. Identity vẫn khai báo commit `488703ad00e5…`, `sourceState: dirty`, `builtAt: 2026-10-13…`. Không dùng timestamp này để suy thời điểm tạo installer. Gates chạy trên **Windows checkout dirty**, không phải chạy tự động trên binary Ubuntu; chưa có receipt chứng minh toàn bộ dirty source trùng chính xác source của binary. Hash installed/package chỉ chứng minh đã dùng đúng `.deb` mới. [Desktop log](../../artifacts/ubuntu-uat-round2-20261020/desktop-x11-session.log), [API](../../artifacts/ubuntu-uat-round2-20261020/api-observations.json).

## 2. Ma trận đối chiếu xử lý lỗi vòng 1

| Mã UAT | Mô tả lỗi vòng 1 | Trạng thái vòng 2 | Kết quả kiểm chứng thực tế & số liệu | Ảnh / log minh chứng |
|---|---|---|---|---|
| UAT-01 | Full giả; thiếu runtime/receipt Scratch; TS12 `.sb3` JE | **PASS** | Distribution `core`; Scratch managed 0.1.7 từ `/usr/lib/JudgeDesk`; ready ngay, Diagnose PASS; F9 TS12 AC 1/1, output `42`; bắt được bwrap chạy Scratch | [F6](../../artifacts/ubuntu-uat-round2-20261020/029-f6-scratch-ready.png), [Diagnose](../../artifacts/ubuntu-uat-round2-20261020/030-diagnose-scratch.png), [AC detail](../../artifacts/ubuntu-uat-round2-20261020/041-scratch-ac-details-light.png), [process trace](../../artifacts/ubuntu-uat-round2-20261020/judging-processes.jsonl) |
| UAT-02 | Compiler metadata/readiness mâu thuẫn | **PASS** | C/C++ 13.3.0, Python 3.12.3 đồng nhất OS/status/active/candidates; Pascal/Java false/false khi chưa cài; 6/6 executionMode `quick_verified_direct` | [API JSON](../../artifacts/ubuntu-uat-round2-20261020/api-observations.json), [OS versions](../../artifacts/ubuntu-uat-round2-20261020/environment.json), [F6](../../artifacts/ubuntu-uat-round2-20261020/025-f6-ready.png) |
| UAT-03 | Server 2 failures; Rust executor/core failures | **PASS** | 4 gates exit 0; Rust 9/9; server 955 pass/0 fail/10 skip; Node & Rust golden 30/30, teardown test PASS; native 107+5, step7 5/5 | [Gate results](../../artifacts/ubuntu-uat-round2-20261020/gate-results.json), [server](../../artifacts/ubuntu-uat-round2-20261020/test-server.log), [full](../../artifacts/ubuntu-uat-round2-20261020/check-full.log), [review skip/gate](../../artifacts/ubuntu-uat-round2-20261020/quality-review.md) |
| UAT-04 | Tên bài ngắt dòng cửa sổ hẹp | **SKIPPED / ACCEPTED BY DESIGN** | Theo quyết định Product Owner; không retest responsive như một tiêu chí blocker | Quyết định trong yêu cầu Round 2; [finding vòng 1](judgedesk-ubuntu-uat-1.6.0-2026-10-20.md) |
| UAT-05 | Actual WA Dark khoảng 1,41:1 | **PASS** | Raster rose `(255,161,173)` trên `(9,9,11)` = **10,3772:1**. PARTIAL thật có badge sky và không lọt INCORRECT | [WA Dark](../../artifacts/ubuntu-uat-round2-20261020/055-wa-dark-details.png), [raster JSON](../../artifacts/ubuntu-uat-round2-20261020/contrast-raster.json), [PARTIAL ALL](../../artifacts/ubuntu-uat-round2-20261020/094-partial-test-badge-all.png), [INCORRECT](../../artifacts/ubuntu-uat-round2-20261020/095-partial-excluded-incorrect.png) |
| UAT-06 | Changelog dừng 1.5.5; Help không có Linux | **FAIL — còn thiếu một phần EN** | Changelog 1.6.0 VI/EN và Linux search 5 mục mỗi locale đã sửa. VI có stack bwrap/cgroup/seccomp; EN có Core/Scratch, apt, package formats, nhưng Help EN tìm `bwrap` = 0 và mục toolchains không nêu stack. Changelog EN có stack nhưng không thay thế nội dung Help yêu cầu | [Changelog EN](../../artifacts/ubuntu-uat-round2-20261020/012-stacked-changelog-en.png), [VI](../../artifacts/ubuntu-uat-round2-20261020/022-stacked-changelog-vi.png), [Linux EN](../../artifacts/ubuntu-uat-round2-20261020/005-help-search-linux-en.png), [VI](../../artifacts/ubuntu-uat-round2-20261020/018-help-search-linux-vi.png), [Help VI stack](../../artifacts/ubuntu-uat-round2-20261020/019-help-toolchains-vi.png), [EN thiếu bwrap](../../artifacts/ubuntu-uat-round2-20261020/125-help-bwrap-search-en.png) |
| UAT-07 | Excel tạo file nhưng không mở được khi thiếu handler; phản hồi không rõ | **PASS trong nhánh xuất/fallback đã chạy** | F12 tạo xlsx hợp lệ 20.000 byte; actual endpoint `/api/open-excel` HTTP 200 `success:true, openMode:system-open`; máy không có LibreOffice/soffice/localc nên xdg-open thất bại vì không có handler. Fallback này được PO cho phép. Nhánh LibreOffice `-n` chưa được chứng minh runtime | [UI F12](../../artifacts/ubuntu-uat-round2-20261020/114-excel-export.png), [workbook](../../artifacts/ubuntu-uat-round2-20261020/uat-scores.xlsx), [verification](../../artifacts/ubuntu-uat-round2-20261020/workbook-verification.json), [HTTP](../../artifacts/ubuntu-uat-round2-20261020/export-api-response.json), [opener log](../../artifacts/ubuntu-uat-round2-20261020/desktop-x11-session.log) |
| UAT-08 | View source chỉ tạo file ngoài, không có preview | **FAIL — preview đã sửa, có lỗi Escape mới** | Preview ncmp/wcmp/rcmp6/yesno hiển thị source testlib ngay trong app; Copy đúng 1.297 byte và trạng thái Đã sao chép. Escape đóng luôn cấu hình cha, tái hiện Light/Dark; X của preview giữ cấu hình đúng | [Light ncmp](../../artifacts/ubuntu-uat-round2-20261020/047-preview-ncmp-light.png), [copied](../../artifacts/ubuntu-uat-round2-20261020/050-copy-state-immediate.png), [copy verify](../../artifacts/ubuntu-uat-round2-20261020/checker-copy-verification.json), [Dark wcmp](../../artifacts/ubuntu-uat-round2-20261020/065-preview-wcmp-dark.png), [sau Escape](../../artifacts/ubuntu-uat-round2-20261020/066-preview-escape-repro.png), [X giữ cha](../../artifacts/ubuntu-uat-round2-20261020/074-preview-x-keeps-config.png) |
| UAT-09 | WA/RE/TLE/MLE cùng hiện 0 ở bảng chính | **SKIPPED / ACCEPTED BY DESIGN** | Giữ nguyên theo PO; điểm 0 không bị tính là FAIL UI của lượt này | [Bảng kết quả](../../artifacts/ubuntu-uat-round2-20261020/040-f9-finished.png); quyết định trong yêu cầu Round 2 |
| UAT-10 | Ctrl+I chưa thống nhất contract; Escape Help/Changelog | **PASS** | Help VI/EN mô tả toggle dòng/cột active; UI Ctrl+I chỉ đổi TS11, Ctrl+Shift+I chỉ đổi Custom_Python; đã khôi phục chọn. Escape1 chỉ đóng changelog, Escape2 đóng Help ở cả VI/EN | [EN contract](../../artifacts/ubuntu-uat-round2-20261020/009-shortcuts-toggle-en.png), [VI](../../artifacts/ubuntu-uat-round2-20261020/116-shortcuts-toggle-vi.png), [row](../../artifacts/ubuntu-uat-round2-20261020/107-toggle-active-contestant.png), [column](../../artifacts/ubuntu-uat-round2-20261020/109-toggle-active-problem.png), [Escape1 EN](../../artifacts/ubuntu-uat-round2-20261020/013-escape1-help-remains.png), [Escape2 EN](../../artifacts/ubuntu-uat-round2-20261020/014-escape2-main.png), [Escape1 VI](../../artifacts/ubuntu-uat-round2-20261020/023-escape1-vi.png), [Escape2 VI](../../artifacts/ubuntu-uat-round2-20261020/024-escape2-vi.png) |
| UAT-11 | Tên package/đường dẫn checklist không khớp artifact | **PASS cho package/path đã xác minh** | `dpkg -s judge-desk` exit 0; đúng ba executable `/usr/bin`; đúng Scratch path. Có một sai tên endpoint trong checklist Round 2: export-score-workbook 404, open-excel 200; ghi riêng, không quy thành hỏng F12 | [Environment](../../artifacts/ubuntu-uat-round2-20261020/environment.json), [hash installed](../../artifacts/ubuntu-uat-round2-20261020/installed-package-comparison.json), [endpoint responses](../../artifacts/ubuntu-uat-round2-20261020/export-api-response.json) |
| UAT-12 | VI còn Native protection | **PASS** | Menu VI có **Bảo vệ thực thi gốc**, **Sẵn sàng**, version **1.6.0**; không còn label Native protection ở menu đã quan sát | [Menu VI Light](../../artifacts/ubuntu-uat-round2-20261020/016-system-status-vi.png), [Dark](../../artifacts/ubuntu-uat-round2-20261020/053-dark-system-menu.png) |

Các giá trị `14.2.0`/`3.12.10` còn xuất hiện trong **catalog/supportedVersions** của API, không phải version executable đã phát hiện. PASS UAT-02 áp dụng cho status/active/candidates thực tế; không tuyên bố mọi chuỗi catalog đã biến mất.

## 3. Kết quả kiểm thử chức năng — 8 nhóm

| Nhóm chức năng | Kết quả Round 2 | Kiểm chứng và giới hạn | Minh chứng |
|---|---|---|---|
| 1. Main, Light/Dark, VI/EN, responsive | **PASS phạm vi retest; responsive ABD** | Đổi locale/theme giữ bảng 8×12; hệ thống dịch đúng. Cửa sổ hẹp không nghiệm thu lại theo quyết định PO | [VI Light](../../artifacts/ubuntu-uat-round2-20261020/040-f9-finished.png), [VI Dark](../../artifacts/ubuntu-uat-round2-20261020/054-dark-scoreboard.png), [EN Light/frame](../../artifacts/ubuntu-uat-round2-20261020/127-window-frame.png) |
| 2. F1 Help, changelog, stacked modal | **FAIL một phần EN** | F1, Linux search VI/EN, v1.6.0 VI/EN, hai Escape stacked đều đúng; Help EN thiếu stack sandbox | [Linux search](../../artifacts/ubuntu-uat-round2-20261020/005-help-search-linux-en.png), [apt EN](../../artifacts/ubuntu-uat-round2-20261020/124-toolchains-linux-guidance-en.png), [packages EN](../../artifacts/ubuntu-uat-round2-20261020/007-help-linux-portable-en.png), [packages VI](../../artifacts/ubuntu-uat-round2-20261020/117-help-linux-packages-vi.png), [EN gap](../../artifacts/ubuntu-uat-round2-20261020/125-help-bwrap-search-en.png) |
| 3. F6 compiler/runtime & sandbox | **PASS** | C++, C, Python, Scratch ready và Diagnose PASS trên GUI; local_auto/local_path hiển thị cho Linux. Pascal/Java chưa cài, không thử compiler/wrapper tùy chọn | [CPP](../../artifacts/ubuntu-uat-round2-20261020/026-diagnose-cpp.png), [C](../../artifacts/ubuntu-uat-round2-20261020/027-diagnose-c.png), [Python](../../artifacts/ubuntu-uat-round2-20261020/029-f6-scratch-ready.png), [Scratch](../../artifacts/ubuntu-uat-round2-20261020/030-diagnose-scratch.png) |
| 4. F2/F3, bảng điểm & keyboard | **PASS phạm vi retest** | Nạp đủ 8/12 từ path fixture; natural TS1…TS12; toggle active row/column đúng. Không tuyên bố lặp toàn bộ phím điều hướng của Round 1 | [F2 path](../../artifacts/ubuntu-uat-round2-20261020/036-problem-picker-existing.png), [loaded](../../artifacts/ubuntu-uat-round2-20261020/037-loaded-8x12.png), [row toggle](../../artifacts/ubuntu-uat-round2-20261020/107-toggle-active-contestant.png), [column toggle](../../artifacts/ubuntu-uat-round2-20261020/109-toggle-active-problem.png) |
| 5. Cấu hình bài / source preview | **FAIL Escape nested** | Đã thử 4 checker built-in; source testlib đọc/copy được; Light/Dark. Open external tạo cpp+h, chưa quan sát editor; Escape làm đóng cha. Các phép thử nhập rational/flags/1024 MB của Round 1 không nằm trong retest sâu lần này | [ncmp](../../artifacts/ubuntu-uat-round2-20261020/047-preview-ncmp-light.png), [wcmp](../../artifacts/ubuntu-uat-round2-20261020/065-preview-wcmp-dark.png), [rcmp6](../../artifacts/ubuntu-uat-round2-20261020/073-preview-rcmp6-dark.png), [yesno](../../artifacts/ubuntu-uat-round2-20261020/076-preview-yesno-dark.png), [Escape](../../artifacts/ubuntu-uat-round2-20261020/066-preview-escape-repro.png) |
| 6. F9 realtime, verdict, Scratch, PARTIAL | **PASS** | F9 toàn bộ 96 giao điểm, có tiến trình; C/C++/Python, File I/O, custom checkers, interactive, group partial và Scratch có kết quả. JE Pascal/Java phù hợp máy chưa có compiler, không fallback | [progress](../../artifacts/ubuntu-uat-round2-20261020/038-f9-started.png), [kết quả](../../artifacts/ubuntu-uat-round2-20261020/040-f9-finished.png), [Scratch](../../artifacts/ubuntu-uat-round2-20261020/041-scratch-ac-details-light.png), [group](../../artifacts/ubuntu-uat-round2-20261020/057-group-partial-all.png), [raster](../../artifacts/ubuntu-uat-round2-20261020/contrast-raster.json), [PARTIAL](../../artifacts/ubuntu-uat-round2-20261020/096-partial-filter.png) |
| 7. F8 OSD, Ctrl+S/O, F12 Excel | **PASS phần đã chạy; giới hạn opener** | OSD tiếp nhận Python HALF, log PARTIAL và 1 processed; stop xác nhận qua UI/API. Archive restore loại thay đổi OSD rồi resave workspace bằng nhau. Xlsx 3 sheets/12 rows hợp lệ; chưa mở bằng LibreOffice thật | [OSD active](../../artifacts/ubuntu-uat-round2-20261020/090-osd-active.png), [processed](../../artifacts/ubuntu-uat-round2-20261020/098-osd-stop-inspect.png), [off](../../artifacts/ubuntu-uat-round2-20261020/099-osd-stopped-confirm.png), [log](../../artifacts/ubuntu-uat-round2-20261020/osd-partial.log), [archive comparison](../../artifacts/ubuntu-uat-round2-20261020/archive-roundtrip.json), [xlsx](../../artifacts/ubuntu-uat-round2-20261020/workbook-verification.json) |
| 8. Distribution, single-instance & cleanup | **PASS** | Core/linux/deb/x64; lần mở thứ hai không tạo cửa sổ/backend mới; đóng qua X, không kill để làm sạch phiên cuối | [API](../../artifacts/ubuntu-uat-round2-20261020/api-observations.json), [single-instance](../../artifacts/ubuntu-uat-round2-20261020/single-instance.json), [frame trước X](../../artifacts/ubuntu-uat-round2-20261020/128-single-instance-primary.png), [cleanup](../../artifacts/ubuntu-uat-round2-20261020/cleanup-final.json) |

## 4. Quality gates trên source hiện tại

Các lệnh chạy tại `D:/Minh/Code/judgedesk` trên **Windows**, Node **24.19.0**, npm **11.17.0**, Cargo **1.97.1**. [Thời điểm/exit codes](../../artifacts/ubuntu-uat-round2-20261020/gate-results.json).

| Lệnh | Kết quả | Chi tiết / log |
|---|---|---|
| `npm run check:fast` | **PASS — 0** | Types và invariant gate sạch. [Log](../../artifacts/ubuntu-uat-round2-20261020/check-fast.log) |
| `npm run test:server` | **PASS — 0** | **965 tests; 955 pass; 0 fail; 10 skipped; 0 cancelled/todo**. Node golden **30/30**, Rust adapter golden **30/30**; `quiesces async toolchain background operations before adapter teardown` PASS. [Log đầy đủ](../../artifacts/ubuntu-uat-round2-20261020/test-server.log) |
| `npm run check:full` | **PASS — 0** | fast → Rust → server → Themis static parity → version đều hoàn tất. Rust thật **9/9 PASS**, không dừng ở executor/core như vòng 1. Server lặp lại 955/0/10. Static parity Node/Rust/C++/Windows packaged đều PASS; mỗi corpus 67 fixtures. [Log đầy đủ runner](../../artifacts/ubuntu-uat-round2-20261020/check-full.log) |
| `npm run release:check-version` | **PASS — 0** | 8-file lockstep **1.6.0**. [Log](../../artifacts/ubuntu-uat-round2-20261020/release-check-version.log) |
| `cargo test --locked --manifest-path native-executor/Cargo.toml` bổ sung | **PASS — 0** | **107 lib + 5 main tests**, 0 failed/ignored. [Output trực tiếp](../../artifacts/ubuntu-uat-round2-20261020/native-executor-tests.log) |
| `cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml --test step7_pch_and_perf_test` bổ sung | **PASS — 0** | **5/5**, gồm benchmark 3 warmups/20 trials và PCH single-flight/corrupt fallback; **84,03 s** test duration. [Output trực tiếp](../../artifacts/ubuntu-uat-round2-20261020/step7-pch-and-perf.log), [exit codes](../../artifacts/ubuntu-uat-round2-20261020/targeted-rust-results.json) |

Chín bước Rust thật trong check:full:

| Component | fmt | clippy `--all-targets -D warnings` | cargo test |
|---|---|---|---|
| native-executor | PASS, 976 ms | PASS, 535 ms | PASS, 13.632 ms |
| judgedesk-core | PASS, 572 ms | PASS, 10.337 ms | PASS, 369.313 ms |
| src-tauri | PASS, 586 ms | PASS, 23.279 ms | PASS, 36.788 ms |

Log runner Rust chỉ in summary khi thành công; vì vậy lưu thêm output trực tiếp của native unit tests và step7, không suy số testcase chi tiết từ chữ PASS của runner. Trong phần server của check:full có **`Rust Gates Aggregate Summary: FAILED / 2 steps`** do unit test âm cố tình dùng `dummy-hung-path-1/2` để chứng minh aggregator không bỏ qua lỗi. Đây không phải kết quả của 9 bước Rust thật; test âm và cả tiến trình full đều PASS.

### Kiểm tra không hạ quality bar

`CONSTRAINTS.md` và `scripts/check-quality-gate.js` không đổi so với HEAD; không có file test bị xóa trong tracked diff. Hai lỗi server vòng 1 vẫn được thực thi, expected golden 30/30 và HTTP 202 không bị giảm để né lỗi. Đối chiếu runner/diff cho thấy bổ sung Rust parity và cô lập TEMP/appdata, không bỏ suite lỗi. [Review chi tiết](../../artifacts/ubuntu-uat-round2-20261020/quality-review.md), [patch test](../../artifacts/ubuntu-uat-round2-20261020/test-changes.patch), [gate/contract diff](../../artifacts/ubuntu-uat-round2-20261020/quality-contract-diff.txt), [deleted-file scan](../../artifacts/ubuntu-uat-round2-20261020/deleted-test-files.txt).

**10 skips được công khai, không che thành PASS:** 5 ca symlink thiếu quyền Windows; 2 ca managed-cache symlink/alias dành cho non-Windows; 3 ca real-toolchain yêu cầu biến opt-in. Số discovered/skipped bằng vòng 1. [Tên/lý do skip](../../artifacts/ubuntu-uat-round2-20261020/skipped-tests.txt). Không phát hiện skip gian lận trong các điểm đã rà soát; không tuyên bố chứng minh tương đương mọi assertion của toàn bộ dirty diff.

## 5. Đo đạc chi tiết

### 5.1. Diagnose và đồng bộ toolchain

| Ngôn ngữ | Nguồn/version thực tế | Compile | Sandbox runtime | Bộ nhớ UI |
|---|---|---:|---:|---:|
| C++ | system, 13.3.0 | 710 ms | 12 ms | 1.532 KB |
| C | system, 13.3.0 | 97 ms | 7 ms | 1.272 KB |
| Python | system, 3.12.3 | UI không nêu compile | 143 ms | 4.832 KB |
| Scratch | managed, 0.1.7 | UI không nêu compile | 199 ms | 18.748 KB |

Các giá trị này đọc từ Diagnose GUI, không phải benchmark compiler độc lập. [Ảnh C++](../../artifacts/ubuntu-uat-round2-20261020/026-diagnose-cpp.png), [C](../../artifacts/ubuntu-uat-round2-20261020/027-diagnose-c.png), [Python](../../artifacts/ubuntu-uat-round2-20261020/029-f6-scratch-ready.png), [Scratch](../../artifacts/ubuntu-uat-round2-20261020/030-diagnose-scratch.png).

OS/status/active/candidates C++ và Python đồng nhất 100% ở các trường version đã đối chiếu. Pascal/Java không có executable, active.ready=false, capabilities.detected=false/submissionReady=false; không coi JE của bài nộp hai ngôn ngữ này là lỗi nhận diện. Không cài fpc/javac hoặc dùng wrapper giả compiler. UI cho phép lựa chọn local_auto/local_path, nhưng nhánh thực thi của Pascal/Java sau cài chưa test.

### 5.2. F9 và Scratch

- Tổng **96 ô**, **26 submission**, **70 không có bài**. Verdict submission: **16 AC, 1 WA, 1 CE, 1 RE, 1 TLE, 1 MLE, 4 JE, 1 PARTIAL**. Bốn JE là Pascal/Java chưa cài; 70 ô không bài có status nội bộ FAIL/not_found không phải 70 lỗi chấm.
- **70 testcase results:** 49 AC, 6 WA, 5 RE, 5 TLE, 5 MLE. F9 được quan sát realtime; timer ảnh progress là **41 s**, ảnh hoàn tất được lưu không muộn hơn **59,330 s từ backend startedAt**. Đây là khoảng **[41; 59,330] s**, không phải thời gian hoàn tất chính xác. Gates Windows chạy đồng thời; không dùng kết quả làm so sánh hiệu năng release.
- Scratch TS12: summary **AC 1/1**, expected/actual cùng **`42\n`**; compileTime=0; executionTime=**644 ms**, wallTimeUs=**644716**, securitySetupTimeUs=**46175**, resultCollectionTimeUs=**2661**, userCpuTimeUs=**375225**, kernelCpuTimeUs=**129388**; peakMemoryBytes=**19206144**, giới hạn **268435456 byte**, exit 0.
- Trace `/proc` bắt được `bwrap … --unshare-all … --cap-drop ALL … --clearenv … --seccomp 12 -- …/scratch-run project.sb3`; runtime snapshot dưới `/tmp/JudgeDeskExecutor/toolchains/scratch-linux-x64_0.1.7`. Không chỉ dựa vào nhãn secureRunner để nói Scratch chạy sandbox. Không thực hiện pentest escape/network riêng trong Round 2.

[JSON kết quả đầy đủ](../../artifacts/ubuntu-uat-round2-20261020/judge-results.json), [metrics](../../artifacts/ubuntu-uat-round2-20261020/execution-metrics.json), [trace](../../artifacts/ubuntu-uat-round2-20261020/judging-processes.jsonl), [Scratch GUI](../../artifacts/ubuntu-uat-round2-20261020/041-scratch-ac-details-light.png).

### 5.3. Contrast raster WA Dark và PARTIAL

Ảnh `055-wa-dark-details.png`, ROI **x=[968,1140), y=[255,273)** ở tiêu đề Actual đầu tiên. Màu nền phổ biến **(9,9,11)**; màu chữ rose đặc phổ biến **(255,161,173)** có **201 pixel**. Tính luminance sRGB theo công thức tương phản cho ra **10,377204:1 > 4,5:1**. Chọn pixel nét chữ đặc; không lấy pixel rìa chống răng cưa làm màu chữ. Đây là phép đo raster tại ROI đã chỉ rõ, không phải chứng nhận contrast cho toàn app. [Script đo](../../artifacts/ubuntu-uat-round2-20261020/measure-contrast.py), [JSON](../../artifacts/ubuntu-uat-round2-20261020/contrast-raster.json).

Fixture group TS11/check_groups có **PARTIAL 10/15** nhưng testcase chỉ gồm 3 AC + 1 WA; không dùng nó để tuyên bố đã kiểm tra badge testcase PARTIAL. Thay vào đó, sau khi lưu baseline, OSD nhận bài bổ sung **`[TS11_GroupPartial][Custom_Python].py`**, nội dung `print("HALF")`. Checker Python sẵn có trả `result = 0.5`, tạo **PARTIAL 5/10**, runtime **0,0810 s**, **4,70 MB**. ALL/PARTIAL hiển thị badge sky; INCORRECT hiện “Không có test nào khớp…”. Không sửa checker, không bơm kết quả giả vào app. Sau thử đã mở lại archive baseline, loại thay đổi OSD khỏi workspace cuối. [ALL](../../artifacts/ubuntu-uat-round2-20261020/094-partial-test-badge-all.png), [INCORRECT](../../artifacts/ubuntu-uat-round2-20261020/095-partial-excluded-incorrect.png), [PARTIAL](../../artifacts/ubuntu-uat-round2-20261020/096-partial-filter.png), [log](../../artifacts/ubuntu-uat-round2-20261020/osd-partial.log).

### 5.4. Archive round-trip

Ctrl+S tạo archive baseline **29.390 byte**; Ctrl+O mở lại, dữ liệu/điểm Scratch được giữ. Sau phép thử OSD, Ctrl+O hiện cảnh báo unsaved đúng; chọn Không lưu để trở về baseline. Toggle active row/column tắt rồi bật, giữ nguyên selection nhưng tạo dirty state, sau đó Ctrl+Shift+S lưu sang **`roundtrip-resaved.judgedesk` 29.295 byte**.

So sánh toàn bộ `manifest.workspace` trước/sau: **workspaceEqual=true**, bao gồm contestants, problems, problemConfigs, selectedContestants, selectedProblems và judgeResult. `savedAt` khác **14:36:28.295Z → 14:43:58.707Z**, chứng minh file resave mới; không chỉ so hai bản sao của cùng file. Chênh kích thước ZIP không phải mất workspace. Phím Save/Save As khi clean bị khóa theo ứng dụng; không lấy thao tác clean không ghi file làm bằng chứng resave.

[Baseline](../../artifacts/ubuntu-uat-round2-20261020/archive-before.judgedesk), [resaved](../../artifacts/ubuntu-uat-round2-20261020/roundtrip-resaved.judgedesk), [comparison](../../artifacts/ubuntu-uat-round2-20261020/archive-roundtrip.json), [unsaved prompt](../../artifacts/ubuntu-uat-round2-20261020/101-open-dirty-prompt.png), [GUI sau lưu](../../artifacts/ubuntu-uat-round2-20261020/113-roundtrip-resaved.png).

### 5.5. Excel, endpoint và opener

F12 tạo `Book.xlsx` dưới `/tmp/judgedesk/exports/<uuid>/`; bản sao evidence **20.000 byte**, SHA-256 `a46230a709c3389bbcd92f5977d988b700db630f25c1cab59197c8d9a0bfca78`. ZIP integrity không lỗi; 10 XML; sheets **Bảng Điểm / Chi Tiết / Run Metadata**; scoreboard **13 hàng gồm header + 12 thí sinh**. [Workbook](../../artifacts/ubuntu-uat-round2-20261020/uat-scores.xlsx), [validation](../../artifacts/ubuntu-uat-round2-20261020/workbook-verification.json), [giá trị từng ô](../../artifacts/ubuntu-uat-round2-20261020/workbook-scoreboard-rows.json).

Đã replay payload hợp lệ từ workbook/diagnostics do F12 tạo, qua HTTP của **chính phiên binary đang chạy**, không dùng dev server:

| POST endpoint | Phản hồi |
|---|---|
| `/api/export-score-workbook` như checklist | **404**, body rỗng |
| `/api/open-excel` endpoint ứng dụng thực tế | **200**, `success:true`, path + diagnosticsPath, `openMode:"system-open"` |

[JSON phản hồi](../../artifacts/ubuntu-uat-round2-20261020/export-api-response.json). Phản hồi 200 không chứng minh ứng dụng bảng tính đã mở. Máy không có `libreoffice`, `soffice`, `localc`; log thực tế cho thấy xdg-open không tìm được handler. Không đánh FAIL chỉ vì điều kiện thiếu ứng dụng ngoài khi PO đã chấp nhận fallback, cũng không tuyên bố đã test runtime thứ tự LibreOffice/soffice/localc hoặc tham số `-n`. Windows `EXCEL.EXE /t` không được retest trong phiên Linux này. Checklist nên đổi sang endpoint thực tế, trừ khi PO muốn bổ sung alias API thành yêu cầu sản phẩm mới.

### 5.6. Single-instance và dọn tiến trình

Lần mở thứ hai exit **0**, **92,558838 ms**. Trước/sau giữ nguyên **PID 709** (app) và **PID 722** (internal job supervisor), chỉ **1 cửa sổ JudgeDesk**. Hai process cùng executable ở đây là app + supervisor có cmdline phân biệt, không phải hai instance GUI. [JSON](../../artifacts/ubuntu-uat-round2-20261020/single-instance.json), [log lần hai](../../artifacts/ubuntu-uat-round2-20261020/second-instance.log).

Đóng bằng **X ở titlebar WSLg** trong frame đã quan sát; không dùng kill cho cleanup cuối. Sau đó inventory `/proc` theo executable và comm (kể cả truncation 15 ký tự) bốn lần cách khoảng 1 s: **0 themis-v2, 0 judgedesk-executor, 0 bwrap, 0 server**; root X11 không còn cửa sổ app. OSD đã tắt, queueLength=0 trước đóng. [Frame trước X](../../artifacts/ubuntu-uat-round2-20261020/128-single-instance-primary.png), [OSD final](../../artifacts/ubuntu-uat-round2-20261020/osd-final-status.json), [cleanup 4 mẫu](../../artifacts/ubuntu-uat-round2-20261020/cleanup-final.json). Không dùng `pgrep -x judgedesk-executor` đơn lẻ vì tên dài hơn giới hạn comm của Linux.

## 6. Lỗi mới / còn tồn đọng và phần chưa chứng minh

### P0 / P1

**Không phát hiện P0/P1 mới có bằng chứng trong Round 2.** Scratch và source gates vòng 1 đều đã qua phép retest. Đây không phải chứng nhận an toàn sandbox toàn diện hoặc kết quả trên distro/native desktop khác.

### P2 — R2-01: Escape của checker source preview đóng luôn cấu hình cha

- **Tái hiện:** nạp bài → menu bài → Cấu hình → Basic → chọn `ncmp` hoặc `wcmp` → Xem nguồn → nhấn Escape đúng một lần.
- **Kỳ vọng:** chỉ source preview đóng, cấu hình đang chỉnh vẫn còn, giữ lựa chọn nháp.
- **Thực tế:** trở thẳng bảng điểm; cả cấu hình cha đóng và lựa chọn checker nháp mất. Tái hiện **hai lần**, Light/ncmp và Dark/wcmp. Không phải chỉ chuyển focus hoặc ảnh trung gian.
- Đối chứng: nút **X của preview `rcmp6`** chỉ đóng preview và giữ cấu hình với lựa chọn `rcmp6`.
- **Ảnh:** [trước Light](../../artifacts/ubuntu-uat-round2-20261020/047-preview-ncmp-light.png), [sau một Escape Light](../../artifacts/ubuntu-uat-round2-20261020/051-preview-escape-returns-basic.png), [trước Dark](../../artifacts/ubuntu-uat-round2-20261020/065-preview-wcmp-dark.png), [sau một Escape Dark](../../artifacts/ubuntu-uat-round2-20261020/066-preview-escape-repro.png), [X giữ cha](../../artifacts/ubuntu-uat-round2-20261020/074-preview-x-keeps-config.png).
- Hướng điều tra sau QA: thứ tự/ưu tiên handler Escape của ProblemConfigModal và BasicProblemSettings, modal con nằm trong subtree cha. Không sửa source trong nhiệm vụ nghiệm thu.

### P3 — R2-02 / UAT-06: Help EN thiếu stack sandbox Linux

- **Tái hiện:** đổi EN → F1 → tìm Linux (5 mục) → Languages & toolchains; đọc đầu/cuối mục; tìm tiếp `bwrap`.
- **Thực tế:** EN có system toolchains, Scratch và lệnh apt, nhưng không nêu bwrap/cgroup v2/seccomp như phần VI. Tìm `bwrap` trả **0 sections**. Changelog EN 1.6.0 có stack này, nhưng nội dung changelog không nằm trong kết quả tìm Help.
- **Ảnh:** [EN đầu](../../artifacts/ubuntu-uat-round2-20261020/123-toolchains-en-top.png), [EN cuối/apt](../../artifacts/ubuntu-uat-round2-20261020/124-toolchains-linux-guidance-en.png), [0 bwrap](../../artifacts/ubuntu-uat-round2-20261020/125-help-bwrap-search-en.png), [VI có stack](../../artifacts/ubuntu-uat-round2-20261020/019-help-toolchains-vi.png).
- Cần đồng bộ nội dung Help EN và retest tìm kiếm trên binary đóng gói; không xem source JSON mới là bằng chứng đã sửa GUI.

### P3 — R2-03: Chi tiết Python qua OSD thiếu số compile time

- **Tái hiện:** OSD nhận `[TS11_GroupPartial][Custom_Python].py` với `print("HALF")` → mở chi tiết kết quả.
- **Thực tế:** heading **“Biên dịch thành công trong ms”** không có số; testcase vẫn có thời gian/bộ nhớ và PARTIAL đúng. Không ảnh hưởng điểm trong ca này.
- **Ảnh/log:** [chi tiết](../../artifacts/ubuntu-uat-round2-20261020/094-partial-test-badge-all.png), [bộ lọc](../../artifacts/ubuntu-uat-round2-20261020/096-partial-filter.png), [OSD log](../../artifacts/ubuntu-uat-round2-20261020/osd-partial.log).
- Cần quyết định hiển thị phù hợp cho Python không có compile duration; không mặc định gán 0 để che thiếu dữ liệu.

### Giới hạn và điều kiện chốt nghiệm thu

- UAT-04/UAT-09 là **ACCEPTED BY DESIGN**, không yêu cầu sửa để đóng Round 2.
- Cần sửa R2-01 và đồng bộ Help EN theo checklist; R2-03 là polish dữ liệu hiển thị. Retest đúng artifact sau rebuild, giữ nguyên quality bar.
- LibreOffice thật chưa cài nên chưa chứng minh GUI Calc mở bản nháp với `-n`; external source editor cũng chưa quan sát mở, dù file `.cpp`+`testlib.h` và clipboard đúng. Đây là giới hạn môi trường, không chứng minh lỗi tạo file.
- Pascal/Java local_auto/local_path sau cài compiler chưa test; không dùng wrapper giả làm bằng chứng compiler thật. Không thử RPM/AppImage, Ubuntu GNOME native, helper Windows capture thành công, PCH hit rate Linux hay contrast toàn ứng dụng.
- `/api/export-score-workbook` 404 là sai khác giữa checklist và endpoint hiện hữu, được công khai; F12 dùng `/api/open-excel` thực sự hoạt động. Không tự thêm alias hoặc sửa backend để “qua UAT”.
- QA chỉ cài lại bộ `.deb` được chỉ định, chuẩn bị fixture bản sao, chạy phép thử, lưu evidence và viết báo cáo; không sửa runtime/test/gate/dependency, không commit/push/release. Phiên cuối **Light/EN, OSD off**, app đã đóng bằng X. [Git status trước](../../artifacts/ubuntu-uat-round2-20261020/git-status-before.txt), [sau](../../artifacts/ubuntu-uat-round2-20261020/git-status-after.txt).
