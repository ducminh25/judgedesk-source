# Windows local test checklist (không release)

Tài liệu này dành cho máy Windows hiện tại và bản source trong
`D:\Minh\Code\judgedesk`. Không publish release, không chạy updater và không tải
artifact lên GitHub/CodeMagic trong quy trình này.

## Trạng thái trước khi test

- Native executor Windows đã tự kiểm tra LPAC + Job Object và bộ security/limit test tự động đã
  pass.
- Fixture trong `server/security-fixtures` là chương trình cố ý phá hoại. **Không compile hoặc mở
  chúng trực tiếp**; chỉ chạy bằng `npm run test:security` hoặc qua ứng dụng khi Native protection
  báo `Sẵn sàng`.
- GCC managed và linker đã được chạy trong AppContainer với cache toolchain chỉ đọc. Trên Windows,
  secure judging tự ưu tiên bản managed đã cài hoặc cache managed hợp lệ, kể cả khi preference UI
  vẫn là **System**. Runtime hệ thống/tùy chỉnh chỉ bị từ chối khi không có managed runtime an toàn.
- Performance gate hiện chưa đạt hoàn toàn trên máy này: p95 và bộ nhớ đạt, p50 của dispatch +
  sandbox setup là khoảng 6,70 ms so với ngưỡng 5 ms. Đây là blocker phát hành, không ngăn smoke
  test correctness thủ công.

## 1. Chạy test tự động trước

Mở **Developer PowerShell for VS 2022** từ Start Menu. Cửa sổ này cần thiết để `link.exe` có trong
`PATH` khi Tauri biên dịch app.

```powershell
Set-Location 'D:\Minh\Code\judgedesk'
npm ci --no-audit --no-fund
npm run lint
npm run test:server
npm run test:executor
npm run test:security
```

Kỳ vọng:

- `lint`: exit code 0.
- `test:server`: 476 tests (466 pass, 0 fail, 10 skipped).
- `test:executor`: toàn bộ Rust unit test pass.
- `test:security`: 8 test pass; có ma trận TLE/MLE lặp 20 lần, OLE, write quota, thread bomb,
  immutable artifact cache và
  cancel. Lệnh mất khoảng 45–70 giây trên máy này.

Chỉ cần chạy `npm ci` khi mới checkout hoặc `package-lock.json` thay đổi. Nếu gặp `EPERM ... unlink
lightningcss.win32-x64-msvc.node`, hãy đóng JudgeDesk và terminal `npm run test:desktop`/Vite cũ,
đảm bảo không còn app của dự án chạy rồi thử lại; lỗi này có nghĩa DLL native vẫn đang bị một tiến
trình giữ. Không tiếp tục `lint`/`test:server` sau một lần `npm ci` thất bại vì `tsc`/`tsx` có thể đã
bị xóa một phần.

Nếu `test:security` nói `SECURE_RUNNER_SELF_TEST_FAILED`, dừng tại đây và gửi toàn bộ output; không
thử chạy fixture bằng lệnh khác.

## 2. Mở ứng dụng từ source

Vẫn trong **Developer PowerShell for VS 2022**:

```powershell
Set-Location 'D:\Minh\Code\judgedesk'
npm run build:executor
npm run test:desktop
```

`npm run test:desktop` sẽ build backend, mở Vite với HMR bị tắt và tự mở cửa sổ **JudgeDesk**. HMR
bị tắt để thay đổi file/reconnect khi test không reload WebView và làm mất state. Giữ terminal này
mở trong suốt buổi test vì log backend/executor xuất hiện ở đó.

Để tắt sạch:

1. Đóng cửa sổ JudgeDesk.
2. Quay lại terminal và nhấn `Ctrl+C` một lần.
3. Nếu chạy lại mà báo `server.exe` bị khóa, đóng cửa sổ JudgeDesk cũ và terminal cũ trước.

## 3. Smoke test khi app vừa mở

- [X] Cửa sổ mở maximized, không trắng màn hình, không hiện lỗi kết nối backend.
- [X] Nhấn biểu tượng bánh răng ở góc phải.
- [X] Dòng **Native protection** là `Sẵn sàng`.

- [X] `Trình chạy hoạt động` là `windows-lpac-job`.
- [X] Không có diagnostic màu đỏ.
- [ ] Mở **Compilers & Runtimes Manager**, xác nhận G++ managed 14.2.0 hoặc managed cache được nhận
  diện. Preference có thể vẫn là **System**; lượt secure judging phải tự dùng managed 14.2.0.
- [X] Đổi Việt/Anh và sáng/tối; menu, bảng và modal vẫn hiển thị bình thường.
- [ ] Alt+Tab ra/vào, click trong app và nhấn nút **Tải lại** nhiều lần; không xuất hiện hộp thoại
  Chromium **Reload site?**.
- [ ] Khi mới mở app, scoreboard trống. Nhấn **Tải lại** trước khi nạp folder không được tự hiện dữ
  liệu cũ; đường dẫn lần trước chỉ xuất hiện sẵn bên trong hai modal chọn folder.
- [ ] Đóng app; terminal không còn tiến trình chấm chạy dở.

Nếu Native protection không `Sẵn sàng`, nút **Chấm bài** phải bị khóa. Đây là hành vi fail-closed
đúng; chụp menu trạng thái và gửi log terminal.

## 4. Nạp bộ dữ liệu có sẵn trên máy

Mở lại app, sau đó:

1. Nhấn biểu tượng clipboard **Nạp danh sách bài thi**.
2. Chọn `D:\Minh\Code\stress_test_judge\test`, rồi **Tải dữ liệu**.
3. Nhấn biểu tượng người dùng **Nạp danh sách thí sinh**.
4. Chọn `D:\Minh\Code\stress_test_judge\contestants`, rồi **Tải dữ liệu**.
5. Chỉ chọn một thí sinh và một bài cho mỗi lượt đầu; không chọn tất cả ngay.

Checklist nạp dữ liệu:

- [X] Có các bài `A_plus_B`, `check_c1` … `check_groups`.
- [X] Có các thí sinh `AC_cpp`, `WA_cpp`, `CE_cpp`, `TLE_cpp`, `MLE_cpp`, `OLE_cpp`, `RE_cpp`.
- [X] Có thể chọn/bỏ chọn từng hàng và cột.
- [ ] Nút **Chấm bài** chỉ sáng khi đã chọn test, thí sinh, bài và Native protection sẵn sàng.
- [X] Bỏ chọn tất cả thí sinh: **Chấm bài** tắt.
- [X] Chọn lại tất cả thí sinh khi còn ít nhất một bài được chọn: **Chấm bài** sáng lại.
- [X] Bỏ chọn tất cả bài: **Chấm bài** tắt; chọn lại tất cả bài khi còn ít nhất một thí sinh được
  chọn: **Chấm bài** sáng lại.
- [ ] Nút **Xuất Excel** sáng khi bảng điểm có ít nhất một thí sinh hoặc một bài; có thể xuất trước
  khi chấm và các ô chưa có kết quả phải để trống.
- [ ] Trên máy có Microsoft Excel, **Xuất Excel** mở một workbook mới chưa lưu từ nguồn `.xlsx`;
  `Ctrl+S` hoặc đóng workbook phải hiện luồng chọn nơi lưu, mặc định là `.xlsx`.
- [ ] Double-click ô kết quả mở modal chi tiết; các nhãn `MLE`, `OLE`, `JE` được dịch đúng.

## 5. Ma trận chấm thủ công

Chạy từng dòng riêng để dễ truy lỗi:

| Thí sinh                 | Bài                 | Kỳ vọng                                       |
| ------------------------- | -------------------- | ----------------------------------------------- |
| `AC_cpp`                | `A_plus_B`         | Compile`OK`, `AC`, 5/5, pass 5 test         |
| `WA_cpp`                | `A_plus_B`         | Compile`OK`, `WA`, 0/5                      |
| `CE_cpp`                | `A_plus_B`         | `CE`, không chạy submission                 |
| `TLE_cpp`               | `A_plus_B`         | `TLE`, app vẫn phản hồi                    |
| `TLE_Sleep_cpp`         | `A_plus_B`         | `TLE` theo wall-clock                         |
| `MLE_cpp`               | `A_plus_B`         | `MLE`, không bị đổi thành `RE`/`TLE` |
| `OLE_cpp`               | `A_plus_B`         | `OLE`, không bị đổi thành `TLE`        |
| `RE_cpp`                | `A_plus_B`         | `RE`                                          |
| `AC_custom_cpp_and_exe` | `check_custom_cpp` | `AC`, 1/1                                     |
| `Group_PassAll`         | `check_groups`     | `AC`, 15/15, pass 4 test                      |

Sau mỗi lượt:

- [ ] Mở **Chi tiết chấm**, kiểm tra thời gian và peak memory có giá trị hợp lý.
- [ ] Expected output không xuất hiện trong actual output hoặc diagnostic.
- [ ] Chọn **Chấm lại** cho một ô; kết quả ổn định.
- [ ] Xóa điểm một ô và chấm lại; các ô khác không đổi.

## 6. Cancel và lifecycle

Sau khi compile hoạt động:

1. Chọn `TLE_cpp` và `TLE_Sleep_cpp` với `A_plus_B`.
2. Nhấn **Chấm bài**, rồi nhấn **Dừng** trong khoảng 1 giây.

- [ ] Progress dừng nhanh, không ghi kết quả nửa chừng thành `RE`.
- [ ] Có thể chấm lượt mới ngay sau đó.
- [ ] Đóng cửa sổ khi đang chấm; app thoát, không để submission chạy nền.
- [ ] Mở app lại; không có workspace cũ gây lỗi hoặc làm mất dữ liệu kỳ thi.

## 7. Kiểm tra cô lập

Không mở các file `Sec_*` trực tiếp. Sau khi compiler được sửa, chạy chúng **từ app** từng trường
hợp và chỉ khi menu vẫn báo Native protection sẵn sàng:

- `Sec_FileRead_cpp`: không đọc được file người dùng/contest khác.
- `Sec_WriteFile_cpp`: không ghi hoặc xóa được file ngoài workspace.
- `Sec_Network_cpp`: không kết nối loopback/LAN/Internet.
- `Sec_ForkBomb_cpp` và `Sec_SystemCmd_cpp`: không tạo được process tree ngoài Job.

Kỳ vọng chung: không trường hợp nào được `AC`, không file người dùng nào thay đổi, app vẫn hoạt động
và có thể chạy lượt tiếp theo. Nếu Native protection chuyển sang unavailable thì dừng test.

## 8. Save/open/export

- [ ] Lưu kỳ thi thành archive mới; đóng và mở lại giữ nguyên selection/config/kết quả.
- [ ] Khi có thay đổi chưa lưu, New/Open/Close hỏi Save/Discard đúng.
- [ ] Export Excel mở được workbook; điểm và verdict khớp bảng.
- [ ] Đường dẫn có dấu cách/Unicode nạp và chấm được.

## 9. Benchmark (chỉ sau khi correctness pass)

Không dùng benchmark để chạy fixture độc hại ngoài executor.

```powershell
npm run benchmark:executor -- --iterations 1000 --suites 5 --warmups 20 --enforce
```

Kết quả được ghi vào `docs\benchmarks\executor-win32-x64.json` và `.md`. Gửi cả hai file nếu gate
p50/p95 fail. Chưa chạy benchmark Themis hoặc tuyên bố hiệu năng tốt hơn khi correctness/compile
chưa pass.

## 10. MSI local (chưa thực hiện ở giai đoạn hiện tại)

Chỉ build MSI local sau khi tất cả mục correctness ở trên pass:

```powershell
npm run build:windows:local
```

Không upload MSI, không tạo GitHub release và không bật updater. Khi có MSI, lặp lại checklist từ
mục 3 trên bản cài đặt, đặc biệt app close/cancel, Native protection và toolchain persistence.

## Thông tin cần gửi khi có lỗi

1. Mục checklist bị fail và thao tác ngay trước đó.
2. Ảnh menu **Trạng thái hệ thống**.
3. Ảnh modal **Chi tiết chấm** nếu có verdict sai.
4. Toàn bộ log terminal từ lúc mở app đến khi lỗi.
5. Tên thí sinh/bài/test và thời điểm xảy ra lỗi.
6. Không gửi source contest bí mật hoặc token; executor không cần các dữ liệu đó trong diagnostic.
