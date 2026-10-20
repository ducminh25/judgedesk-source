# Báo cáo nghiệm thu JudgeDesk 1.6.0 trên Ubuntu

Ngày kiểm thử: **20/10/2026**, múi giờ Asia/Bangkok. Thực hiện trực tiếp trên bản cài Linux bằng skill Computer Use qua cửa sổ WSLg. Dữ liệu, ảnh và log: [`artifacts/ubuntu-uat-20261020`](../../artifacts/ubuntu-uat-20261020/).

## 1. Tổng quan và kết luận

**Kết luận: CHƯA ĐẠT để phê duyệt phát hành theo toàn bộ tiêu chí yêu cầu.**

Đường chấm C++/C/Python, File I/O, custom checker C++/Python, nhóm điểm, bài tương tác, OSD, lưu/mở kỳ thi và xuất Excel đã hoạt động trong các phép thử thực tế. Không quan sát crash của phiên nghiệm thu chính. Sau khi đóng bằng nút X, không còn tiến trình JudgeDesk, executor hoặc bwrap.

Các điểm ngăn nghiệm thu đầy đủ:

- Bản cài tự nhận **Full** nhưng Scratch không sẵn sàng và bài `.sb3` nhận JE do thiếu managed package/receipt.
- Metadata compiler giữa hệ điều hành, compiler đang hoạt động, danh sách ứng viên và `/api/status` không thống nhất.
- Help/changelog chưa cập nhật Linux/1.6.0; giao diện hẹp còn ngắt tên bài thành nhiều dòng; tiêu đề Actual trong chi tiết WA ở Dark rất khó đọc.
- `test:server` và `check:full` của checkout hiện tại thất bại. Đây là kết quả **trên host Windows**, không được quy thành lỗi tái hiện trên binary Ubuntu nếu chưa có bằng chứng tương ứng.
- Một số phép đo và nhánh kiểm thử chưa được chứng minh, được liệt kê tại mục 5. Không coi ảnh chụp hoặc test source là bằng chứng thay thế cho các nhánh đó.

### Môi trường và định danh

| Thành phần | Kết quả thực tế |
|---|---|
| Distro | `JudgeDesk-Ubuntu-24.04`, Ubuntu **24.04.5 LTS**, amd64 |
| Kernel | `6.18.33.2-microsoft-standard-WSL2` |
| glibc | `2.39-0ubuntu8.9` |
| WebKit2GTK | `2.52.6-0ubuntu0.24.04.1`, API 4.1 |
| GTK3 | `3.24.41-4ubuntu1.3` |
| Hiển thị | WSLg `1.0.73.2`, `DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0` |
| Gói đã cài | **`judge-desk` 1.6.0**, `install ok installed`, amd64 |
| Executable | `/usr/bin/themis-v2` |
| Executor và sidecar đóng gói | `/usr/bin/judgedesk-executor`, `/usr/bin/server` |
| Backend đang dùng | Pure Rust Core nhúng trong Tauri; log xác nhận `backend: rust`, `buildMode: packaged` |
| Build | `local-488703ad00e5`, commit `488703ad00e5b10648defcf644ed3ad4bbdee304`, `sourceState: dirty` |
| Thời gian build khai báo | `2026-10-13T01:52:09.000Z`; không dùng trường này để suy ra thời điểm tạo gói |
| Compiler thực tế | GCC/G++ **13.3.0**, Python **3.12.3** |
| Compiler chưa cài | `fpc`, `javac` không có; không cài thêm compiler trong lượt này |
| Công cụ Linux | Bubblewrap **0.9.0**, Zenity **4.0.1**, cgroup v2 có controller `memory`, `pids`, `cpu` |
| `/api/distribution` | HTTP 200: `{"arch":"x64","bundleType":"deb","distribution":"full","platform":"linux"}` |
| Sandbox API | `ready: true`, mode `linux-bwrap-cgroup-seccomp`, executor `1.6.0`, diagnostics rỗng |
| Các cờ sandbox API | `networkBlocked`, `filesystemIsolated`, `processTreeControlled`, `memoryLimitSupported` đều `true` |
| Dữ liệu ứng dụng | Help hiển thị mặc định `~/.local/share/ThemisV2`; cache PCH tồn tại tại đó. Shell/WebKit/log dùng thêm `~/.local/share/com.themisv2.judge` |
| Kích thước ảnh | Maximized **1536×792**; cửa sổ thường/hẹp thường **1066×682**, vùng app khoảng 1024 px. Chưa đo DPI độc lập |

`dpkg -s judgedesk` thất bại vì tên package thực tế là `judge-desk`. Hai đường dẫn `/usr/lib/JudgeDesk/binaries/{server,judgedesk-executor}` trong kịch bản không tồn tại; file được đóng gói dưới `/usr/bin`. Vì bản đúng 1.6.0 đã cài, không chạy lại apt.

SHA-256 gói `JudgeDesk_1.6.0_amd64.deb`:

```text
f0c8eb70dea8a0e2fa0e07a7ee39ab59b025e7ee0e416a49759b7f3131ffd12d
```

Bằng chứng: [môi trường và hash](../../artifacts/ubuntu-uat-20261020/environment.json), [diagnostics lấy qua clipboard](../../artifacts/ubuntu-uat-20261020/diagnostics.txt), [API thực tế](../../artifacts/ubuntu-uat-20261020/api-observations.json).

### Phạm vi dữ liệu và phương pháp

- Tạo bản sao tại `/tmp/judgedesk-uat-contest/{Problems,Contestants}`; không sửa bộ `stress_test_judge` gốc.
- 8 bài: `A_plus_B`, `File_IO`, `check_groups`, `Weighted`, `check_custom_cpp`, `Custom_Python`, `Interactive`, `Scratch`.
- 12 thí sinh ẩn danh TS1…TS12; có C++, C, Python, Pascal, Java và Scratch. Ca WA/CE/RE/TLE/MLE lấy từ fixture có sẵn; interactor và Scratch lấy từ corpus trong repo.
- Không đưa các fixture phá hoại `Sec_*`/`ZZ_DANGEROUS_*` vào lượt nghiệm thu này. Đây không phải pentest sandbox.
- Thao tác UI dùng `@oai/sky`: quan sát, click, phím tắt, cuộn và screenshot. Lệnh hệ thống chỉ dùng cho chuẩn bị fixture, kiểm tra gói/API/file/process và quality gates.
- 174 PNG được giữ làm bằng chứng, gồm ảnh trung gian. Danh mục có thời điểm/kích thước ở [screenshots.json](../../artifacts/ubuntu-uat-20261020/screenshots.json); tên ảnh trung gian không được xem là kết quả PASS nếu nội dung chưa ổn định.
- Sau OSD, manifest lưu có 96 ô bài/thí sinh: 70 ô không có submission, 26 ô có submission; tổng 69 kết quả testcase. Các ô không có bài có status nội bộ `FAIL`, không được đếm thành 70 lỗi chấm.

## 2. Bảng kết quả kiểm thử chức năng

PASS chỉ áp dụng cho hành vi có bằng chứng. WARN là kiểm thử một phần hoặc có giới hạn. FAIL là tiêu chí yêu cầu không đáp ứng trong lượt kiểm thử.

| Mục | Trạng thái | Kết quả và số liệu | Minh chứng chính |
|---|---|---|---|
| 1. Main, Light/Dark, VI/EN, responsive | **FAIL** | Đã quan sát đủ 8 tổ hợp theme × locale × maximized/hẹp và empty/populated. Đổi theme/locale giữ dữ liệu. Ở hẹp, `check_custom_cpp`, `check_groups`, `Interactive`, `Weighted` ngắt nhiều dòng; chưa đạt hợp đồng tên bài dễ đọc. Chưa có số đo cold-start chính xác. | [empty](../../artifacts/ubuntu-uat-20261020/03-empty-light-en.png), [hẹp VI sáng](../../artifacts/ubuntu-uat-20261020/154-scoreboard-narrow-light-vi.png), [hẹp EN tối](../../artifacts/ubuntu-uat-20261020/158-scoreboard-narrow-dark-en-clean.png) |
| 2. Help F1 và diagnostics | **FAIL** | F1 mở Help; đã xem Quick start, Toolchains, Compile flags, Portable, About. Search `Linux` trả 0 mục. Version 1.6.0, Linux/x64 và đường dẫn mặc định đúng; Copy diagnostics thành công qua clipboard WSLg. Escape đóng Help. Tài liệu About/Portable chỉ mô tả Windows/macOS; changelog cold start dừng ở v1.5.5. | [Help](../../artifacts/ubuntu-uat-20261020/05-help-light-en-settled.png), [Portable](../../artifacts/ubuntu-uat-20261020/07-help-compile-flags.png), [About](../../artifacts/ubuntu-uat-20261020/08-help-about.png), [copy](../../artifacts/ubuntu-uat-20261020/09-help-copy-diagnostics.png), [search Linux](../../artifacts/ubuntu-uat-20261020/13-help-search-linux.png) |
| 3. F6, compiler/runtime và sandbox | **FAIL** | C++, C, Python tự đạt Submission ready, không trỏ đường dẫn. Rescan phản hồi, không treo quan sát được; chưa có timing end-to-end riêng của rescan. Menu hệ thống báo Native protection Ready và runner Linux đúng. Pascal/Java không cài nên nhánh local-auto có compiler chưa kiểm thử. Scratch Not available dù edition Full. Ứng viên GCC/Python có version sai khác thực tế. | [F6](../../artifacts/ubuntu-uat-20261020/16-toolchain-settled.png), [Scratch](../../artifacts/ubuntu-uat-20261020/19-toolchain-scratch-sandbox.png), [sandbox menu](../../artifacts/ubuntu-uat-20261020/47-preferences.png), [Scratch JE](../../artifacts/ubuntu-uat-20261020/174-scratch-je-diagnostics.png) |
| 4. F2/F3/F5, bảng điểm và bàn phím | **WARN** | Nạp đủ 8 bài/12 thí sinh, natural sort TS1…TS12 đúng. Native GTK Browse/Open thành công khi target đúng cửa sổ WSLg; không kết luận picker bị treo từ ảnh trắng ban đầu. Ctrl+A/D, Ctrl+Shift+A/D, Right/Down, Space được quan sát; F5 giữ TS2 bỏ chọn. Ctrl+I/Ctrl+Shift+I chỉ đổi đối tượng active, khác kỳ vọng đảo toàn bộ trong yêu cầu. Up/Left chưa có bằng chứng thao tác riêng. | [native folder](../../artifacts/ubuntu-uat-20261020/138-picker-current-folder.png), [Open thành công](../../artifacts/ubuntu-uat-20261020/139-picker-open-success.png), [natural sort](../../artifacts/ubuntu-uat-20261020/38-scoreboard-loaded-narrow-light-en.png), [Right](../../artifacts/ubuntu-uat-20261020/56-keyboard-right-focused.png), [Down](../../artifacts/ubuntu-uat-20261020/57-keyboard-down.png), [Space](../../artifacts/ubuntu-uat-20261020/58-keyboard-space.png), [F5](../../artifacts/ubuntu-uat-20261020/59-reload-preserves-selection.png) |
| 5. Cấu hình bài, 3 tabs | **WARN** | Đã đổi File→Standard I/O, bật Interactive trong nháp; nhập 1024 MB; duyệt checker list. Quick group `1-2`→Sub1 đúng. Edit group tổng `1/3` cho ra `1/6` mỗi test, tổng bài `10/3`. Thử Themis/Modern/ICPC/Custom; `-O3` hợp lệ, `-o hack` bị chặn, Save vẫn khóa ở Basic. Draft giữ qua tabs. Test well-formed báo toàn bộ input hợp lệ. View source sinh `.cpp`+`testlib.h`, nhưng không quan sát được cửa sổ editor/preview mở ra. | [1024 MB](../../artifacts/ubuntu-uat-20261020/64-memory-1024.png), [phân số](../../artifacts/ubuntu-uat-20261020/75-group-rational-third.png), [áp dụng](../../artifacts/ubuntu-uat-20261020/76-group-rational-applied.png), [flag bị chặn](../../artifacts/ubuntu-uat-20261020/83-forbidden-output-flag.png), [validation xuyên tab](../../artifacts/ubuntu-uat-20261020/84-draft-preserved-cross-tab-validation.png), [I/O](../../artifacts/ubuntu-uat-20261020/166-file-to-standard-io.png), [Interactive](../../artifacts/ubuntu-uat-20261020/167-interactive-config-toggle.png), [well-formed](../../artifacts/ubuntu-uat-20261020/172-validation-enabled.png) |
| 6. F9, realtime, scoring, sort, details | **WARN** | F9 chấm thực tế, tiến trình cập nhật; hoàn tất được quan sát trong khoảng trên 57 s và không quá **82,587 s từ thao tác F9**. Đây là khoảng polling, không phải duration chính xác. AC C++ `10/3`, C/Python AC; File I/O, checker C++/Python, group partial và interactive đạt kết quả phù hợp. Đã mở AC/WA/CE/RE/TLE/MLE/Interactive. Sort giảm→tăng→mặc định đúng khi click nút mũi tên. PCH có cache nhưng chưa chứng minh hit từng submission. | [progress](../../artifacts/ubuntu-uat-20261020/94-judge-running-state.png), [kết quả](../../artifacts/ubuntu-uat-20261020/98-judge-progress-verdicts.png), [AC](../../artifacts/ubuntu-uat-20261020/99-details-ac.png), [WA](../../artifacts/ubuntu-uat-20261020/101-details-wa.png), [CE](../../artifacts/ubuntu-uat-20261020/104-details-ce-settled.png), [RE](../../artifacts/ubuntu-uat-20261020/106-details-re.png), [TLE](../../artifacts/ubuntu-uat-20261020/108-details-tle.png), [MLE](../../artifacts/ubuntu-uat-20261020/110-details-mle.png), [Interactive](../../artifacts/ubuntu-uat-20261020/112-details-interactive.png), [sort giảm](../../artifacts/ubuntu-uat-20261020/116-total-sort-control.png), [sort tăng](../../artifacts/ubuntu-uat-20261020/117-total-sort-asc.png), [mặc định](../../artifacts/ubuntu-uat-20261020/118-total-sort-default.png) |
| 7. OSD, archive và Excel | **WARN** | OSD nhận hai file AC/WA cho TS1, sinh log; bài WA làm điểm `10/3`→`0`, tổng `133.33`→`130`. Watcher đã tắt. Ctrl+S tạo archive **30.881 byte**; Ctrl+N hiện đủ Save/Don't save/Cancel; Ctrl+O phục hồi. Workspace trước/sau resave **trùng khớp hoàn toàn**. F12 tạo workbook **19.922 byte**, 3 sheet, 12 thí sinh, đúng thứ tự giảm dần. App tự xuất vào thư mục tạm rồi gọi xdg-open; máy không có ứng dụng mở xlsx, UI không báo đường dẫn rõ ràng. `/tmp/uat-scores.xlsx` là bản sao của file app tạo, không phải đường dẫn chọn qua Save As. | [OSD bật](../../artifacts/ubuntu-uat-20261020/123-osd-active.png), [đổi điểm](../../artifacts/ubuntu-uat-20261020/126-osd-wa-result.png), [log AC](../../artifacts/ubuntu-uat-20261020/osd-submission.log), [log WA](../../artifacts/ubuntu-uat-20261020/osd-wa.log), [warning](../../artifacts/ubuntu-uat-20261020/141-unsaved-warning.png), [restore](../../artifacts/ubuntu-uat-20261020/145-archive-restored.png), [so sánh archive](../../artifacts/ubuntu-uat-20261020/archive-roundtrip.json), [kiểm tra xlsx](../../artifacts/ubuntu-uat-20261020/workbook-verification.json) |
| 8. Distribution, single-instance và cleanup | **PASS** | API báo linux/deb/x64 đúng. Khởi chạy lần hai exit 0 sau **181 ms**, PID chính giữ nguyên, chỉ một cửa sổ. Phiên chính đóng bằng X; 4 mẫu kiểm tra trong hơn 3 s đều 0 tiến trình phù hợp. Phiên phụ đọc API sau restart cũng được kết thúc và kiểm tra 0 tiến trình; không dùng ảnh lỗi capture của phiên phụ làm bằng chứng UI. | [single instance](../../artifacts/ubuntu-uat-20261020/162-single-instance-primary.png), [timing](../../artifacts/ubuntu-uat-20261020/second-instance.json), [API](../../artifacts/ubuntu-uat-20261020/api-observations.json), [đóng GUI](../../artifacts/ubuntu-uat-20261020/cleanup-first-verified.json), [cleanup cuối](../../artifacts/ubuntu-uat-20261020/cleanup-final.json) |

### Đo đạc chi tiết và giới hạn của số liệu

| Phép đo | Kết quả | Diễn giải |
|---|---|---|
| Cold start lần đầu | Chụp được changelog/empty state | Không có đồng hồ từ lúc process start tới first paint; **chưa đo duration chính xác** |
| Tạo PCH | **3370 ms**, `.gch` **83.589.244 byte** | Đọc metadata cache hiện có sau khởi chạy; profile C++14/O2/pipe, GCC 13.3. Không phải thời gian compile submission |
| Compile C++ `A_plus_B` lần đầu | **9105 ms** | UI AC ban đầu; bài đã chuyển sang custom GNU++20/O3. Không dùng số này làm benchmark PCH C++14 |
| Compile C++ profile mặc định | `check_custom_cpp` 865 ms; `check_groups` 656 ms; `Custom_Python` 533 ms; `File_IO` 946 ms; `Weighted` 2017 ms | Kết quả archive. Cache tồn tại không chứng minh hit từng compiler invocation |
| Interactive | Compile **1846 ms**, test khoảng **31 ms**, **1,25 MB**, AC `1/1`, `ok` | Đã quan sát modal thực tế |
| AC C++ testcase | Khoảng **12–17 ms**, **1,00–1,67 MB** | Số hiển thị ở modal AC lần đầu; không phải tổng RSS app |
| TLE | 5 test hiển thị **1,0000 s**, khoảng **1–2 MB** | Không đủ để kết luận độ chính xác biên 1,001 s từ số đã làm tròn |
| Ca MLE | Test 1 TLE tại khoảng **1005,96 MB**; 4 test sau MLE tại **1024,00 MB** | TL 1 s có thể tới trước ML; chưa tái chạy với TL dài hơn để có MLE thuần 5/5 |
| RE | `SIGFPE`, exit **136**, 0/5 | Không lẫn với lỗi biên dịch |
| Tổng lượt chấm | Quan sát ở UI từ 0% tới hoàn tất; giới hạn trên **82.587 ms** tính từ F9 | Bao gồm trễ dispatch/capture; không có trace hoàn tất chính xác |
| Lưu/mở | `workspaceEqual: true` | So sánh toàn bộ cấu trúc contestants/problems/config/selections/judgeResult, không chỉ tổng điểm |
| Excel | ZIP hợp lệ, **19.922 byte**, sheets `Bảng Điểm`, `Chi Tiết`, `Run Metadata` | Đọc XML của file do app tạo. Không mở bằng LibreOffice/Excel trên Ubuntu vì chưa cài app tương ứng |

Log metadata: [PCH](../../artifacts/ubuntu-uat-20261020/pch-metadata.json), [timing UI](../../artifacts/ubuntu-uat-20261020/timing-observations.json), [69 testcase và execution metadata](../../artifacts/ubuntu-uat-20261020/judge-results-summary.json). Native source có nhánh đọc `memory.peak`; số MB trong báo cáo là số executor/UI trả về, chưa đối chiếu bằng một bộ lấy mẫu cgroup độc lập.

### Quality gates của checkout hiện tại

Các lệnh dưới đây chạy trên **Windows workspace**, không phải bộ test tự động chạy dưới Ubuntu. Không sửa source, hạ gate, thêm dependency hoặc bỏ test để làm xanh.

| Lệnh | Kết quả |
|---|---|
| `npm run check:fast` | **PASS**, exit 0; TypeScript và quality invariants sạch |
| `npm run test:server` | **FAIL**, exit 1; **965 tests, 953 pass, 2 fail, 10 skipped được runner báo**, 43 suites |
| `npm run check:full` | **FAIL**, exit 1; Rust 9 bước, 7 pass/2 fail. Dừng tại Rust, nên các stage server/parity/version phía sau không chạy trong lệnh này |
| `npm run release:check-version` riêng | **PASS**, version 1.6.0 |

Hai server failures: `post-toolchain-install` không khớp golden fixture; `quiesces async toolchain background operations before adapter teardown` nhận 503 thay vì 202. Rust: executor lib báo 105 pass/2 fail; core thất bại ở target `step7_pch_and_perf_test`. Runner full chỉ lưu phần đuôi, chưa có đủ tên hai executor test lỗi; không đoán nguyên nhân.

Log: [fast](../../artifacts/ubuntu-uat-20261020/check-fast.log), [server](../../artifacts/ubuntu-uat-20261020/test-server.log), [full](../../artifacts/ubuntu-uat-20261020/check-full.log), [version](../../artifacts/ubuntu-uat-20261020/version-check.log).

## 3. Đánh giá UI/UX Ubuntu

### 3.1. Desktop contract và anti-AI-slop

Modal cấu hình có phân tầng rõ, ba tab gọn, viền mảnh, góc nhỏ; footer Lưu/Hủy luôn tiếp cận được trong các trạng thái đã xem. Bảng điểm giữ mật độ cao và số dạng mono/tabular. Không thấy gradient trang trí, backdrop blur hoặc pill button nổi bật trong các màn đã quan sát.

Các nút toolbar vẫn có nhiều màu icon; cột Tổng điểm dùng nền tím khá lớn. Đây là polish, không phải lỗi logic. Quầng sáng quanh con trỏ trong ảnh xuất hiện theo cơ chế Computer Use/capture; **không quy thành diffuse glow của app**.

### 3.2. Tương phản và Light/Dark parity

Theme đổi trên cùng bảng dữ liệu; màu verdict, modal, menu và vùng chọn có ở cả sáng/tối. Focus tím quanh ô điểm nhìn được. Tuy nhiên, tiêu đề **Kết quả bài làm (Actual)** trong WA Dark gần như chìm vào nền.

Phân tích điểm ảnh của vùng tiêu đề Actual trong ảnh `101-details-wa.png`: điểm đỏ sáng nhất `(74,27,45)` trên nền `(9,9,11)` cho tỷ lệ khoảng **1,41:1**. Đây là phép đo raster có vị trí vùng ảnh, không phải đo computed CSS hoặc chứng nhận WCAG. Kết quả hỗ trợ nhận xét rằng tiêu đề này không đáp ứng mức chữ thường 4,5:1. Chưa kiểm toán đầy đủ mọi cặp màu text/control/focus để xác nhận 4,5:1/3:1 cho toàn ứng dụng.

[Bằng chứng và phương pháp đo](../../artifacts/ubuntu-uat-20261020/contrast-raster.json).

### 3.3. Typography và mật độ dữ liệu

Các điểm `10/3`, `1/6`, số thời gian và bộ nhớ được trình bày có cấu trúc, dễ đối chiếu trong modal. Natural sort thí sinh đúng. Ở maximized, 8 cột bài đọc được.

Ở vùng app khoảng 1024 px, tên bài dài bị bẻ thành 2–3 dòng với mảnh từ ngắn. Chưa thấy thanh cuộn ngang hữu ích giữ nguyên chiều rộng cột trong binary đã cài. Giáo viên sẽ khó xác định bài đang cấu hình/chấm khi nhiều tên gần giống nhau. Cần kiểm lại bản đóng gói với nhiều hơn 8 bài và tên thí sinh rất dài; không suy kết quả đó từ source đang có minimum-width.

### 3.4. VI/EN

Toolbar, modal, verdict, Help đổi ngôn ngữ; không thấy raw translation key trong các màn đã xem. Các label VI chính vẫn vừa footer/modal.

VI còn chuỗi `Native protection` bằng tiếng Anh; Help thiếu nội dung Linux, Portable chỉ nêu Windows/macOS; What’s New dừng ở 1.5.5. Đây là thiếu đồng bộ nội dung của bản cài. Không xác nhận toàn bộ catalog dịch chỉ từ các màn mẫu.

### 3.5. Keyboard và focus

Right/Down đưa focus sang đúng ô; ring nhìn rõ. Space thay đổi chọn thí sinh. Ctrl+A/D và Ctrl+Shift+A/D có tác dụng. Nhóm test có focus rõ khi dùng Tab giữa range/name. Escape đóng Help, manager, details, OSD và modal nạp thư mục trong các lượt đã thử; details trả ring về ô vừa mở.

Changelog lần đầu chưa có bằng chứng Escape đóng thành công, phải click Got it. Up/Left, Enter mở details, Tab trap đầy đủ và return-focus của mọi modal chưa được chứng minh. Không kết luận đạt accessibility toàn diện.

Ctrl+I/Ctrl+Shift+I đổi thí sinh/bài active. Source `src/features/shortcuts/shortcuts.test.ts` cũng quy định như vậy. Do đó đây là **khác biệt giữa checklist yêu cầu và hợp đồng hiện tại**, không tự động coi là regression rồi đổi shortcut.

### 3.6. WebKit2GTK/GTK3 và trải nghiệm thực tế

Font Việt có dấu và icon hiển thị được; Help/Tests/manager cuộn được. Cửa sổ GTK chọn thư mục và Save/Open xuất hiện phía trước, thao tác được khi Computer Use chọn đúng window riêng. Ảnh trắng/không phản ứng ban đầu được tái kiểm tra thành công; không giữ kết luận picker treo.

Trong resize từng có frame trắng/vùng vẽ cũ, frame sau ổn định. Log có cảnh báo EGL/ZINK và hai `Gtk-CRITICAL` lúc thao tác; không có crash tương ứng trong phiên chính. Không có trace FPS/scroll-latency để quy mức độ giật hay nguyên nhân compositor. [Trích console phiên desktop](../../artifacts/ubuntu-uat-20261020/desktop-session-observations.md).

WSLg là môi trường Linux được cho phép trong yêu cầu, nhưng không đại diện đầy đủ GNOME Ubuntu native. Không có phiên Windows/macOS đối chứng trên cùng fixture trong lượt này; không đưa ra kết luận Linux tốt/xấu hơn hai nền tảng đó.

Sau restart phục vụ đọc API, Computer Use trả title có `[WARN:COPY MODE]` nhưng frame lại chứa cửa sổ khác. Không gửi click/type theo frame sai, loại ảnh đó khỏi evidence và kết thúc process phiên phụ bằng SIGTERM có kiểm tra PID/executable. Đây là giới hạn capture của lượt kiểm thử, chưa quy thành lỗi JudgeDesk.

## 4. Vấn đề và đề xuất theo ưu tiên

### P0 — Blocker nghiêm trọng

**Chưa phát hiện P0 runtime có bằng chứng.** Không có bằng chứng mất dữ liệu, sandbox escape hay crash chặn toàn bộ workflow trong các ca đã chạy. Điều này không thay thế security audit; kết luận phát hành vẫn CHƯA ĐẠT do P1 và gate chưa xanh.

### P1 — Cần xử lý trước nghiệm thu đầy đủ

**UAT-01. Full Linux thiếu runtime Scratch hoạt động.**

- Hiện tượng: F6 Scratch Not available; `.sb3` nhận `MANAGED TOOLCHAIN NOT READY`, thiếu package hoặc receipt. Distribution API vẫn ghi Full.
- Tái hiện: mở bản `.deb` này → F6 → xem Scratch → nạp fixture TS12/Scratch → F9 → mở ô JE.
- Bằng chứng: [F6 Scratch](../../artifacts/ubuntu-uat-20261020/19-toolchain-scratch-sandbox.png), [JE](../../artifacts/ubuntu-uat-20261020/174-scratch-je-diagnostics.png), [API](../../artifacts/ubuntu-uat-20261020/api-observations.json).
- Hướng xử lý: kiểm tra đóng gói Linux/receipt và resolver managed runtime ở `scripts/build-linux-release.sh`, `server/toolchains`, `crates/judgedesk-core/src/toolchains`; đưa runtime vào edition đã công bố hoặc điều chỉnh chính xác phạm vi edition. Không fallback chạy không sandbox. Tái chấm Scratch trước khi đóng finding. Pascal/Java chưa cài được ghi riêng là thiếu điều kiện môi trường, không gộp thành lỗi auto-detect đã chứng minh.

**UAT-02. Metadata compiler/readiness mâu thuẫn.**

- Hiện tượng: host và active toolchain là GCC 13.3/Python 3.12.3; candidate list ghi GCC 14.2/Python 3.12.10; `/api/status.gpp.version` ghi 14.2.0. API capabilities của Pascal/Java/Scratch còn khai báo `detected/submissionReady` trong khi active `ready:false` và UI Not available.
- Tái hiện: F6 → so sánh active/candidates; Copy diagnostics → đối chiếu `g++ --version`, `python3 --version`; đọc status/toolchains của cùng bản cài.
- Bằng chứng: [F6](../../artifacts/ubuntu-uat-20261020/16-toolchain-settled.png), [môi trường](../../artifacts/ubuntu-uat-20261020/environment.json), [API đầy đủ](../../artifacts/ubuntu-uat-20261020/api-observations.json).
- Hướng xử lý: audit root model ở `crates/judgedesk-core/src/server/routes/system.rs`, toolchain discovery/diagnostics và DTO/shared contracts. Phân biệt khả năng hỗ trợ ngôn ngữ với readiness thực tế; lấy version từ executable đã xác minh, tránh giá trị mặc định cố định. Chưa thấy bằng chứng thực thi nhầm compiler hoặc tự fallback.

**UAT-03. Quality gates hiện tại chưa đạt.**

- Hiện tượng/tái hiện: chạy `npm run test:server` và `npm run check:full` trong checkout hiện tại trên Windows, kết quả như mục 2.
- Bằng chứng là log, không có screenshot UI áp dụng: [server](../../artifacts/ubuntu-uat-20261020/test-server.log), [full](../../artifacts/ubuntu-uat-20261020/check-full.log).
- Hướng xử lý: lấy đầy đủ stdout của executor lib failures và `step7_pch_and_perf_test`; điều tra lifecycle/admission của cặp API-contract tests trước khi sửa. Không sửa golden/threshold/skip chỉ để qua gate. Cần chạy lại trên source đã xác định và nối provenance với gói Linux trước khi phê duyệt release. Không kết luận các failure Windows này đã xảy ra trên Ubuntu.

### P2 — UI/UX và nội dung

**UAT-04. Tên bài khó đọc ở cửa sổ hẹp.** Tái hiện: nạp 8 bài → restore cửa sổ khoảng 1024 px vùng app. [Ảnh](../../artifacts/ubuntu-uat-20261020/154-scoreboard-narrow-light-vi.png). Kiểm tra binary frontend thực sự đóng gói rồi đối chiếu `Scoreboard.tsx`; giữ minimum column width và scroll chủ đích, tooltip/tên đầy đủ, không giảm font để ép đủ cột.

**UAT-05. Actual heading trong WA Dark có tương phản thấp.** Tái hiện: Dark → mở TS4/A_plus_B WA. [Ảnh](../../artifacts/ubuntu-uat-20261020/101-details-wa.png), [raster ~1,41:1](../../artifacts/ubuntu-uat-20261020/contrast-raster.json). Kiểm tra style của `JudgingDetailsModal` trong artifact; source hiện tại có semantic text token ở khu vực tương ứng nên cần xác minh frontend cũ/stale trước khi sửa. Dùng text token đủ tương phản, màu semantic cho nhấn mạnh có kiểm soát.

**UAT-06. Help và changelog chưa đồng bộ Linux/1.6.0.** Tái hiện: mở app lần đầu thấy 1.5.5; F1 → Search Linux không có mục; About/Portable chỉ nêu Windows/macOS. [Cold start](../../artifacts/ubuntu-uat-20261020/01-cold-start-changelog.png), [search](../../artifacts/ubuntu-uat-20261020/13-help-search-linux.png). Cập nhật `src/features/help/help.{vi,en}.json`, dữ liệu release notes và kiểm tra chúng được bundle; thêm cách cài `.deb/.rpm/.AppImage`, compiler/sandbox Linux và giới hạn thật.

**UAT-07. Xuất Excel không chỉ dẫn rõ khi thiếu app liên kết.** Tái hiện: trên Ubuntu chưa có app xlsx → F12 → nút bận rồi trở lại, workbook tồn tại ở thư mục tạm nhưng xdg-open báo không có handler. [UI sau xuất](../../artifacts/ubuntu-uat-20261020/150-export-result.png), [file hợp lệ](../../artifacts/ubuntu-uat-20261020/workbook-verification.json). Đề xuất ở export frontend và tầng OS integration: Save As hoặc thông báo vị trí kèm Open folder/Copy path, báo lỗi mở file tách biệt lỗi tạo workbook. Thiếu LibreOffice là điều kiện môi trường, không phải lỗi tạo xlsx.

**UAT-08. View source chưa đạt trải nghiệm preview trên môi trường này.** Tái hiện: Basic → View source; file `.cpp` và `testlib.h` được tạo, nhưng không có cửa sổ source editor quan sát được. [Ảnh sau click](../../artifacts/ubuntu-uat-20261020/86-checker-preview-settled.png). Handler mặc định `text/x-c++src` là `vim.desktop`; môi trường không có terminal GUI phù hợp được xác minh. `src-tauri/src/checker_sources.rs` dùng OS opener. Cân nhắc preview đọc-only trong app hoặc thông báo đường dẫn/fallback khi mở ngoài thất bại. Không coi đây là bằng chứng thiếu `testlib.h`.

**UAT-09. WA/RE/TLE/MLE cùng biểu diễn “0” ở bảng chính.** Tái hiện: F9 trên fixture → so sánh TS4/TS6/TS7/TS8. [Ảnh](../../artifacts/ubuntu-uat-20261020/98-judge-progress-verdicts.png). Điểm đúng nhưng giáo viên phải mở từng modal. Xem `scoreboard-model.ts`/`Scoreboard.tsx`: bổ sung verdict text/hint, giữ rational score và không suy verdict từ số 0.

**UAT-10. Cần thống nhất ngữ nghĩa Ctrl+I.** Tái hiện: Ctrl+D → Ctrl+I chỉ bật đối tượng active; Ctrl+Shift+D → Ctrl+Shift+I chỉ bật bài active. [Ảnh thí sinh](../../artifacts/ubuntu-uat-20261020/41-selection-ctrl-i.png), [ảnh bài](../../artifacts/ubuntu-uat-20261020/44-problems-ctrl-shift-i.png). Code/tests hiện tại chủ ý `toggleActiveContestant`/`toggleActiveProblem`; checklist yêu cầu đảo toàn bộ. Chốt lại help/acceptance contract trước khi đổi behavior ở `src/features/shortcuts`.

### P3 — Polish và tài liệu vận hành

**UAT-11. Checklist tên gói/đường dẫn không khớp artifact.** `dpkg -s judgedesk` không nhận, tên thật `judge-desk`; sidecar/executor dưới `/usr/bin`. Tái hiện bằng các lệnh ghi trong [environment.json](../../artifacts/ubuntu-uat-20261020/environment.json); screenshot không áp dụng. Đồng bộ INSTALL/verify script với cấu trúc `.deb` thực tế; nếu chuyển layout cần kiểm tra resolver và upgrade.

**UAT-12. VI còn `Native protection`; một số heading dùng viết hoa dày.** [Ảnh](../../artifacts/ubuntu-uat-20261020/152-scoreboard-max-light-vi.png). Bổ sung i18n cho label của system status, ưu tiên sentence case theo desktop contract. Không thay font/icon toàn ứng dụng chỉ vì vấn đề này.

## 5. Phần chưa được chứng minh và điều kiện tái nghiệm thu

Chưa có bằng chứng cho: cold-start first-paint timing chính xác; rescan timing chính xác; PCH hit rate; scroll FPS/latency; Ubuntu GNOME native; đối chứng Windows/macOS; toàn bộ contrast/control/focus pairs; Tab trap/return-focus mọi modal; Up/Left và Enter mở details; Pascal/Java local-auto trên máy đã cài compiler; validation với input cố ý sai; MLE 5/5 với TL đủ dài; hiện preview source thực tế; mở workbook trong phần mềm bảng tính Ubuntu.

Đã phủ cả 8 nhóm chức năng nhưng **không tuyên bố mọi nhánh nhỏ đều PASS**. Ảnh lỗi capture ở phiên API phụ đã loại bỏ; không có click/type vào frame sai. CLI API chỉ dùng để xác minh identity/status, không thay thao tác UI của phiên chính.

Điều kiện phê duyệt lại: xử lý P1; sửa hoặc chốt chấp nhận các P2 ảnh hưởng thao tác; chạy gates không hạ chuẩn; nối source/build receipt với gói Linux; lặp các nhánh còn thiếu trên GUI có capture ổn định. Các giới hạn platform không kiểm thử phải tiếp tục được ghi rõ.

## 6. Bàn giao và bảo toàn

- Bản gốc `stress_test_judge` không được sửa. Không thay code runtime, version, dependency, sandbox hoặc scoring trong nhiệm vụ nghiệm thu.
- Không commit/push/publish/cài toolchain. Chỉ có báo cáo, evidence/scripts nghiệm thu riêng và ghi chú ledger.
- Preferences cuối phiên chính là Light/EN, OSD tắt. Phiên chính đã đóng qua UI. Phiên API phụ đã kết thúc bằng SIGTERM sau khi xác minh PID/executable; kết quả cleanup cuối không còn app/executor/bwrap.
- File bàn giao: [archive đã lưu](../../artifacts/ubuntu-uat-20261020/uat.judgedesk), [workbook do app tạo](../../artifacts/ubuntu-uat-20261020/uat-scores.xlsx), [fixture manifest](../../artifacts/ubuntu-uat-20261020/fixture-manifest.json). Workbook/contest chỉ chứa dữ liệu thử đã ẩn danh.
- Review cuối theo 5 trục: correctness bám evidence và nêu phần thiếu; readability tách kết quả/UI/source; architecture không đổi bốn tầng; security không yếu sandbox/không đưa session token vào artifact; performance chỉ báo số đo có nguồn, không suy PCH hit từ cache.
