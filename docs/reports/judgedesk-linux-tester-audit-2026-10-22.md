# JudgeDesk Linux: đối soát kết quả tester và phương án sửa, 22/10/2026

## Kết luận

Cần sửa hai lỗi runtime trước: môi trường AppImage rò sang chương trình hệ thống và lỗi khởi động checker bị diễn giải thành WA. Ngoài ra cần tách trạng thái đã tạo file Excel khỏi trạng thái yêu cầu mở viewer, hoàn thiện kỳ vọng Linux của stress suite và nghiệm thu đúng build. Chưa triển khai bản Full trong lượt này.

Đây là lượt nghiên cứu, đọc workbook/video/source và chạy các probe nhỏ. Không sửa logic ứng dụng, không build installer, không thêm dependency, không commit/push, không xóa môi trường hoặc dữ liệu. Các script/JSON/ảnh probe nằm trong `artifacts/linux-tester-20261022/`. Phản biện do một agent tự thực hiện theo yêu cầu người dùng, không gọi reviewer/model khác; không gọi đó là fresh-context review.

## Đầu vào và định danh build

| Đầu vào | SHA-256 / thông tin |
| --- | --- |
| `C:/Users/mon/Downloads/stress_deb.xlsx` | `767ebb8e6aec61ec27eb88ff6b89c3212af7981a5610179e7621592c48ee3fa3` |
| `C:/Users/mon/Downloads/fedora_rpm.xlsx` | `3ad1b4d7061e5dfdfe9ab27519e921355e41da432abfd487410e3d3de76cc89c` |
| Video `Screencast From 2026-10-22 12-36-49.mp4` | SHA-256 `bc856210e5827fab15babcdadc43091d979a2c06d4698a93f9ba7d54d12a30da`; 19,822 giây, 1920×1200, 60 fps, không có audio stream |
| Ảnh terminal đính kèm | AppImage có build number `qa-linux22-6dcb22a7689f56ea`; backend Rust hoạt động; LibreOffice/Flatpak lỗi dynamic loader |

Đã đọc toàn bộ cell của cả ba sheet trong mỗi workbook, không ghi lại workbook gốc. Mỗi file có `Bảng Điểm` 95×30, `Chi Tiết` 3104×23 và `Run Metadata` 23×2. Không có cell công thức hoặc cell lỗi Excel. Đã xem contact sheet gồm 20 frame theo từng giây xuyên suốt video và đọc frame gốc tại đoạn dialog Pascal và thao tác export. Video không có audio để phân tích.

Metadata phải được dùng thay cho tên file hay cùng version `1.6.0`:

| Trường | DEB | RPM |
| --- | --- | --- |
| Build number | `qa-linux22-6dcb22a7689f56ea` | `local-19c7a60ad728` |
| Git commit | `e70dcbfb7cae54df5ab28cc5f88cdd1dd67c305f` | `19c7a60ad728deb3d54e79f3a3809c4573a146ae` |
| Build timestamp UTC | 2026-10-21 23:41:05.822 | 2026-10-20 17:14:52 |
| C++ | system 15.2.0 | local_path 16.2.1 |
| Python | system 3.14.4 | local_path 3.14.8 |

Workbook DEB gắn với run của candidate mới. Workbook RPM gắn với run của build cũ, vì vậy chưa chứng minh RPM mới được nghiệm thu trên máy thật. Không đủ bằng chứng kết luận tester đã cài sai: có thể file export chứa run trước đã lưu trong contest. Ảnh AppImage xác nhận candidate mới được khởi động, nhưng không cung cấp hash installer hay JSON kết quả của run AppImage.

## Đối soát stress

Hai workbook có toàn bộ bảng điểm giống nhau; cả 150 cặp thí sinh/bài và 377 testcase đã chạy cũng giống nhau về tên test, verdict và điểm theo đúng thứ tự, không chỉ giống histogram. Timing, memory và thông báo hệ thống có khác nhau như dự kiến giữa hai máy/build.

| Verdict testcase | Số lượng trong mỗi workbook |
| --- | ---: |
| AC | 168 |
| WA | 70 |
| PE | 11 |
| PARTIAL | 1 |
| RE | 77 |
| TLE | 24 |
| MLE | 12 |
| OLE | 13 |
| JE | 1 |

Không coi mọi ô đỏ hoặc mọi JE là bug. `Custom_JE_cpp/Custom_Python` cố ý trả `result = 20` không hợp lệ và nhận JE đúng. Tám project Scratch hỏng/không hỗ trợ nhận CE đúng. `CE_cpp` và `RE_Syntax_python` nhận CE đúng. Fixture Windows dùng `windows.h` không biên dịch trên Linux là điều dự kiến theo bản chất fixture, chưa có expectation Linux chính thức.

Trong 137 ca thông thường của suite: 129 ca còn lại khớp các kỳ vọng portable quan sát được về verdict, số test/thứ tự khi được khai báo, và điểm xuất. Sáu ca bị chặn bởi Java/Pascal, hai ca checker EXE có lỗi thật bên dưới. Đây không phải chứng nhận 129 test Linux theo một contract Linux hoàn chỉnh: `EXPECTED_RESULTS.json` và runner hiện mặc định chỉ khai báo `win32`/`darwin`.

Scratch: 20 ca, 8 CE ở bước kiểm tra project, 27 testcase runtime gồm 17 AC, 6 WA, 1 RE, 2 TLE và 1 OLE; khớp fixtures hiện có trong cả hai workbook. Có bằng chứng runtime Scratch hoạt động, không còn chỉ dựa vào việc binary tồn tại.

Điểm nhóm, Weighted và custom C++/Python khớp dữ liệu xuất. `Rational_OneThird_cpp/Rational_Thirds` hiện `0.33`, phù hợp quy tắc exporter cố ý làm tròn phân số vô hạn đến hai chữ số. Workbook không chứa đủ `scoreExact` để chứng minh backend giữ đúng phân số 1/3: cần diagnostics JSON hoặc API cho assertion đó. Không quy đây thành lỗi tính điểm từ riêng Excel.

13 ca bảo mật là exploratory. Các verdict AC/RE không đủ chứng minh isolation: workbook không chứa toàn bộ output/canary/host assertion và bằng chứng drain. Chưa có bằng chứng sandbox escape từ các file này, cũng không nâng thành security certification. Hai fork-bomb đặc thù Windows/macOS cần được phân loại applicability rõ ràng thay vì chấm toàn bộ trên Linux.

## Lỗi 1: AppImage làm hỏng chương trình hệ thống khi mở Excel

### Bằng chứng và nguyên nhân

Ảnh ghi:

```text
libcurl.so.4: undefined symbol: nghttp2_option_set_no_rfc9113_leading_and_trailing_ws_validation
libaccountsservice.so.0: undefined symbol: g_once_init_leave_pointer
grep: .../.mount_.../usr/lib/libpcre2-8.so.0: no version information available
```

Đây là thư viện trong AppImage bị nạp vào các chương trình Fedora ngoài bundle. Không phải thông báo EGL/Wayland của lỗi trắng cửa sổ trước đó.

`NativeWorkbookOpener` trong `crates/judgedesk-core/src/server/os_integration.rs` gọi LibreOffice bằng `Command::new`, hoặc `xdg-open` khi không tìm thấy LibreOffice. Command kế thừa environment; không có bước khôi phục môi trường host. GTK hook của AppImage cũng sửa `GTK_*`, `GIO_MODULE_DIR`, `GI_TYPELIB_PATH`, `GSETTINGS_SCHEMA_DIR`, `GDK_PIXBUF_MODULE_FILE` và `XDG_DATA_DIRS`. Chỉ xóa hai biến LD giải quyết được lỗi symbol đã tái hiện nhưng chưa đủ bao phủ GTK/GIO/module/schema path.

Đã tái hiện trên Fedora 44 WSL bằng ba thư viện thực lấy từ AppDir build Ubuntu 22.04 hiện tại (nghttp2, GLib, PCRE2), không cài thêm LibreOffice:

| Probe `/usr/bin/curl --version` | Exit | Kết quả |
| --- | ---: | --- |
| Môi trường host | 0 | Bình thường |
| Kế thừa LD_LIBRARY_PATH trỏ đến thư viện bundle | 127 | Đúng symbol nghttp2 trong ảnh; thêm cảnh báo PCRE2 |
| Tiến trình con bỏ LD_LIBRARY_PATH/LD_PRELOAD | 0 | Bình thường |

Đây là reproduction dynamic loader, không phải kiểm thử LibreOffice GUI hay Flatpak trên desktop tester. Evidence: `loader-reproduction.json`.

### Quyết định sửa

1. Ghi nhận riêng các biến environment mà AppRun/linuxdeploy sửa, trước GTK hook và AppRun.wrapped. Khôi phục giá trị host gốc cho các command hệ thống; phân biệt biến chưa đặt với chuỗi rỗng. Snapshot chỉ là dữ liệu environment, không thực thi hay source text từ biến.
2. Một policy command host trên Linux, dùng chung cho workbook opener, lookup viewer, directory picker và các đường mở checker source. Audit cả Tauri opener/plugin và Node opener; tránh chỉ sửa lệnh LibreOffice đầu tiên rồi bỏ sót `xdg-open` hoặc lệnh dò `which`.
3. Giữ nguyên environment của chính WebView/AppImage. Giữ DISPLAY, WAYLAND_DISPLAY, DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR, HOME, locale và các biến phiên cần thiết cho host viewer. Không clear toàn bộ env; không xóa global LD; không đổi backend đồ họa; không sửa library hệ thống.
4. Xác định executable theo PATH host đã khôi phục, truyền argv trực tiếp, tiếp tục giữ validation path và không nội suy shell.
5. DEB/RPM và Windows/macOS phải giữ hành vi hiện tại. Không thay compiler, flags hoặc sandbox grant để xử lý lỗi mở viewer.

## Lỗi 2: lưu workbook và mở viewer đang bị gộp thành một trạng thái

`handle_open_excel` trong `crates/judgedesk-core/src/server/routes/export.rs` ghi `Book.xlsx` và `diagnostics.json` rồi mới gọi opener. `open_workbook_with_mode` chỉ kiểm tra spawn thành công; thread chờ child bỏ qua exit status. Frontend `useScoreboardExport.ts` thấy HTTP thành công thì xóa lỗi, không phân biệt kết quả mở viewer. Wrapper LibreOffice có thể spawn được rồi chết ngay do loader, đúng dạng lỗi terminal đang thấy.

Vì thế nhiều khả năng workbook AppImage đã được tạo nhưng viewer không lên. Chưa đọc được file trên máy tester nên không khẳng định file ở một đường dẫn cụ thể đang tồn tại.

Quyết định: tách kết quả tạo/lưu file và yêu cầu mở file. Khi viewer thất bại, giữ file/diagnostics, trả đường dẫn và lý do mở lỗi cho UI, có cách lưu bản sao/lấy file. Kiểm tra được lỗi spawn và lỗi thoát sớm bằng stderr bị giới hạn; theo dõi child bất đồng bộ, không đợi người dùng đóng LibreOffice mới trả HTTP. `spawn`/gửi yêu cầu mở thành công không được mô tả như chứng minh cửa sổ đã mở. Không retry vô hạn hoặc coi viewer thiếu/hỏng là lỗi chấm.

Phải giữ contract mở workbook mới chưa lưu của Excel Windows và LibreOffice `-n` nếu đang dùng. Thay đổi API/UI trạng thái phải có contract test cả backend Rust và Node.

## Lỗi 3: checker không khởi động được lại thành WA

### Bằng chứng trực tiếp

Trong cả hai workbook, sheet `Chi Tiết`:

| Dòng | Ca | Quan sát |
| --- | --- | --- |
| 225 | `AC_custom_cpp_and_exe/check_custom_exe/test01` | WA, checker message `bwrap: execvp ... .exe: No such file or directory` |
| 2729 | `WA_custom_cpp_and_exe/check_custom_exe/test01` | Cùng WA và lỗi execvp |

Fixture này cấu hình `checkerType: checker.exe`, là binary PE của Windows. Trên Linux cần báo JE khi checker không thực thi được; không được đánh WA cho bài nộp. Hai ca có cùng lỗi nhưng ca AC làm lộ rõ chấm sai. Cột `Exit code=0` tại hàng testcase là kết quả bài nộp, không phải bằng chứng checker đã chạy thành công.

### Nguyên nhân gốc và tái hiện

- `compile_checker_with_executor` chấp nhận đường dẫn `.exe` như artifact đã biên dịch.
- `native-executor/src/platform/linux.rs` coi `child-pid` từ JSON status của Bubblewrap là bằng chứng target đã khởi động. Tuy nhiên Bubblewrap có thể tạo child rồi thất bại ở exec.
- Khi không nhận payload `exit-code`, executor lấy exit code wrapper. Bubblewrap trả 1 khi exec lỗi.
- `run_sandboxed_custom_checker` thấy reason Exited, đưa mã 1 vào parser custom checker; parser đúng contract coi 1 là WA.
- Interactive path cũng dùng fallback từ exit wrapper nên phải được audit/sửa cùng root.

Probe non-root dùng Bubblewrap thật, namespace tách biệt và filesystem bind tối thiểu, không thay policy app:

| Payload | Exit wrapper | JSON có child-pid | JSON có payload exit-code |
| --- | ---: | --- | --- |
| Chương trình thật exit 1 | 1 | Có | Có, giá trị 1 |
| Target không tồn tại | 1 | Có | Không |
| Checker PE của chính stress fixture | 1 | Có | Không |
| Chương trình thật exit 0/2/7 | 0/2/7 | Có | Có |
| Chương trình thật chết SIGFPE | 136 | Có | Có, giá trị 136 |

Đã xác nhận valid exit 1 vs target mất trên Bubblewrap 0.9.0 ở Ubuntu 24 và 0.12.0 ở Ubuntu 22/Fedora 44. Source Bubblewrap 0.12.0 chỉ phát `exit-code` sau khi kiểm tra pipe theo dõi exec. Evidence: `bwrap-launch-reproduction.json`, `bwrap-success-controls.json`, `bwrap-other-distros.json`.

### Quyết định sửa tại root

Đối với strict Bubblewrap run kết thúc theo nhánh Exited, chỉ sử dụng exit của payload khi status có cả child-pid hợp lệ và payload exit-code hợp lệ. Thiếu bản ghi kết thúc phải thành LaunchError/JE với diagnostic, không lấy exit wrapper thay thế. Reuse JSON status pipe và guard hiện có; không cần thêm launcher/helper hoặc dependency mới cho lỗi này.

Áp dụng cùng contract cho submission, checker và interactive participants. Giữ precedence của cancel/resource limits và nguyên nhân cleanup: supervisor chủ động kill vì TLE/MLE/OLE/cancel có thể làm thiếu final status; không chuyển những ca đó thành JE. Interactive cần phân biệt launch thất bại với participant bị dừng do peer/cleanup, thay vì thêm một điều kiện mù sau drain.

Không sửa parser để mọi exit 1 thành JE: checker thật exit 1 vẫn phải WA, 2 vẫn PE, 7 vẫn partial. Không grep stderr để xác định launch, vì output có thể bị checker/bài nộp tạo ra. Không chặn mọi file có đuôi `.exe`: định dạng thực và launch contract mới là cơ sở, tránh làm hỏng ELF hợp lệ được đặt tên như vậy. Không tự chuyển sang checker mặc định hay Wine.

## Java/Pascal: sáu ca chưa chấm được, chưa chứng minh lỗi compiler engine

Các dòng 246, 275, 288, 301, 649, 2024 báo không tìm được compiler/runtime dùng được cho Java hoặc Pascal. Video tại khoảng 5–6 giây cũng mở dialog Pascal File_IO với cùng lỗi. Kết quả JE hiện tại là đúng cách phân loại thiếu điều kiện môi trường, kể cả ca có tên CE_pascal.

Không suy từ thông báo này rằng FPC/JDK chắc chắn chưa được cài: cũng có thể đường dẫn/profile hoặc discovery chưa đạt. Workbook metadata chỉ cung cấp C++/Python, không đủ phân biệt những khả năng đó. Bản Core hiện không cung cấp sẵn mọi toolchain. Không ép tester cài thêm chỉ để làm xanh bộ test.

Quyết định: tách trạng thái chưa có installation, sai executable, compiler/linker thiếu dependency và runtime không qua sandbox probe trong diagnostics; giữ fail-closed và đường dẫn đã chọn. Ca đủ điều kiện mới chạy và so AC/CE/RE; các ca thiếu prerequisite được ghi BLOCKED, không tính PASS hay đổi sang compiler khác. Full sau này mới cung cấp FPC/JDK đã pin và kiểm chứng theo manifest.

## Tự phản biện phương án

| Giả định / đề xuất | Phản chứng đã kiểm tra | Kết luận |
| --- | --- | --- |
| AppImage không tạo được XLSX | Route ghi file trước khi mở viewer; log đến LibreOffice | Tập trung lỗi viewer và trạng thái export; không sửa serializer khi chưa có bằng chứng |
| Chỉ thêm cài LibreOffice là hết | Loader làm hỏng chính LibreOffice/Flatpak đã có | Sửa môi trường con, không thêm dependency viewer như một cách vá |
| Xóa LD toàn cục | WebView dùng thư viện bundle; GTK hook sửa nhiều biến khác | Chỉ khôi phục env của command host, bảo toàn GUI/session |
| Mọi exit 1 của checker là lỗi môi trường | Chương trình hợp lệ exit 1 có final payload status | Giữ mapping verdict; sửa ranh giới launch/exit |
| Có child-pid nghĩa là exec thành công | Target mất và PE đều có child-pid | Cần final payload status, không tin wrapper exit |
| Thiếu final status luôn JE | Cancel/limit/peer cleanup chủ động kill Bubblewrap | Chỉ áp dụng cho normal completion, giữ resource/cancel precedence |
| Excel cùng version chứng minh cùng build | Metadata RPM khác build DEB/AppImage | Pin build/run identity, không quy lỗi thao tác cho tester |
| Các fixture security AC nghĩa là an toàn | Workbook thiếu canary/host output assertions | Giữ exploratory; chưa chứng nhận sandbox từ Excel |
| 0.33 chứng minh sai số rational | Exporter làm tròn hiển thị có chủ ý | Chưa thấy lỗi rational; cần JSON cho assertion exact |

## Thứ tự thực hiện và điều kiện đóng lỗi

1. Viết regression tái hiện checker PE/target mất hiện ra WA; sửa strict payload status và interactive sibling. Test checker hợp lệ 0/1/2/7, signal, dynamic-loader failure, status thiếu/hỏng, TLE/MLE/OLE/cancel và cleanup/drain. Kiểm tra cả submission/compiler/runtime paths để không đổi CE/RE hợp lệ.
2. Test environment host khi chạy dưới AppImage, khôi phục biến trước AppRun tại các command host; test đường LibreOffice và xdg-open, viewer cold start và viewer đã chạy, directory picker/checker preview. Giữ test Windows/macOS và các probe compiler đang có.
3. Test và sửa contract lưu/mở Excel: file còn lấy được khi spawn/early loader fail, thông báo đúng giai đoạn, HTTP không bị giữ đến lúc đóng viewer, không mất diagnostics.
4. Bổ sung contract Linux cho suite và runner bằng dữ liệu/semantics Linux; hai checker PE thành JE, fixture đặc thù OS được giới hạn đúng. Giữ toàn bộ test hiện có và không hạ chuẩn; không sửa expected theo kết quả sai để lấy PASS. Phân biệt BLOCKED do toolchain với FAIL của judge.
5. Chạy gate dự án thích hợp sau implementation, build từ Ubuntu 22.04 và chạy acceptance đúng SHA/build ID. Local QA phải bao gồm full stress và export/open, thay vì chỉ sáu bài cộng hai số. Tester chỉ cần một vòng AppImage export ngắn; RPM mới còn thiếu bằng chứng run mới, không bắt tester test lại toàn bộ mọi package.

Lượt nghiên cứu này chỉ có probe loader/Bubblewrap và đối soát dữ liệu, chưa có implementation nên không tuyên bố các lỗi đã được fix, không chạy full build/test để tạo thêm hàng chục GiB cache. Các probe đã kết thúc, không còn child bwrap của lượt tái hiện.

## Điều kiện nghiên cứu và triển khai Full

Có thể dùng phát hiện này làm đầu vào nghiên cứu Full, nhưng bundle toolchain không giải quyết lỗi viewer hay WA giả. Trước nghiệm thu Full cần đóng các lỗi trên và xử lý hai prerequisite Ubuntu 22.04 đã ghi ở report baseline: CPU delegation của systemd user và Bubblewrap hệ thống 0.6.1 thiếu `--size`.

Nghiên cứu Full tiếp theo nên chốt: toolchain/architecture/version/license và ABI baseline, dung lượng cài/nén, manifest/hash/nguồn gốc, import và giải nén nguyên tử vào vùng user có thể ghi, chống traversal/symlink, dùng được từ đường dẫn bất kỳ, sandbox compile/link/run readiness, PCH cache gắn đúng compiler/header/flags, cập nhật/rollback và dọn phiên bản cũ. AppImage read-only không đồng nghĩa compiler không thể dùng: runtime/toolchain được xác minh rồi import vào vùng quản lý thích hợp; không sửa binary pkg Scratch bằng patchelf. Mọi việc đó là thiết kế tiếp theo, chưa triển khai trong audit này.

## Nguồn kỹ thuật chính

- [Dynamic loader: thứ tự LD_LIBRARY_PATH và thư viện hệ thống](https://man7.org/linux/man-pages/man8/ld.so.8.html).
- [Rust Command: kế thừa environment, env_remove và spawn](https://doc.rust-lang.org/std/process/struct.Command.html).
- [Bubblewrap 0.12.0 source: report_child_exit_status, setup_finished_pipe, execvp](https://raw.githubusercontent.com/containers/bubblewrap/v0.12.0/bubblewrap.c).
- [Tauri: giới hạn ABI baseline của AppImage](https://tauri.app/distribute/appimage/#limitations).
- [Report baseline và prerequisite cài sạch](judgedesk-linux-baseline-2026-10-22.md).
