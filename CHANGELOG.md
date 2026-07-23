# Changelog

Tất cả thay đổi đáng chú ý của JudgeDesk được ghi tại đây. Dự án dùng Semantic
Versioning; các bản `1.x` giữ tương thích updater và dữ liệu ứng dụng hiện có.

## [1.2.4] - 2026-07-23

### Sửa lỗi macOS

- Truyền macOS SDK sysroot vào bước auto-detect Apple Clang, sửa trường hợp
  compiler tồn tại nhưng probe bị `ld: library 'c++' not found` trên Xcode
  17/macOS 26.
- Packaged DMG smoke test giờ bắt buộc backend sidecar thực sự nhận diện được
  Apple Clang; build sẽ fail nếu System Status còn báo G++ `Not detected`.
- Đóng gói compatibility header `bits/stdc++.h` cho Apple Clang/libc++, sửa CE
  của các bài thi C++ viết theo thói quen GCC mà không cần nới quyền sandbox.
- Dùng giới hạn process cấp kernel và hostile regression test để chặn fork bomb
  trên Mac chip M; release gate sẽ fail nếu containment này bị bỏ trong các bản
  cập nhật sau.
- Chèn trap cho phép chia số nguyên với mẫu số thực sự bằng 0 khi compile bằng
  Apple Clang. Chỉ test phát sinh lỗi nhận `RE`, nhất quán với GCC/x86 trên
  Windows; checker, phép chia số thực và các test khác không bị thay đổi.
- Làm rõ bước cài DMG một lần để đổi bundle cũ `ThemisV2.app` thành
  `JudgeDesk.app`; updater in-place vẫn giữ nguyên identifier và dữ liệu.

## [1.2.3] - 2026-07-22

### Sửa lỗi macOS

- Khôi phục auto-detect Apple Clang trên Xcode 17/macOS 26. JudgeDesk không còn
  đánh dấu compiler hợp lệ là `Not detected` khi SDK không cung cấp `libm` độc
  lập.
- Bỏ `-lm` khỏi probe và lệnh compile C++ trên macOS vì các math symbol được
  cung cấp qua `libSystem`; sửa toàn bộ bài C++ bị CE `library 'm' not found`.
- Bỏ cờ strip `-s` đã obsolete trên linker mới của Apple. Windows và Linux vẫn
  giữ nguyên các compiler flag hiện tại.

## [1.2.2] - 2026-07-22

### Sửa lỗi macOS

- Sửa toàn bộ bài C++ bị CE `TOOLCHAIN_NOT_SANDBOX_COMPATIBLE` trên các máy Mac
  mà `xcrun --find clang++` trả về shim `/usr/bin/clang++`. JudgeDesk giờ lấy
  binary Apple Clang thật từ Developer root do `xcode-select` chỉ định.
- Không còn báo Homebrew GCC/LLVM là compiler tương thích với Native protection;
  sandbox vẫn fail closed và chỉ cấp quyền cho Apple Clang từ Xcode hoặc Command
  Line Tools.
- New contest, Open contest và đóng ứng dụng không còn hỏi lưu một contest rỗng
  khi scoreboard chưa có thí sinh hoặc problem.

## [1.2.1] - 2026-07-22

### Native protection và tính đúng đắn

- Thêm native secure executor mặc định: Windows dùng LPAC/AppContainer kết hợp
  Job Object; macOS dùng sandbox profile theo từng run, process group và
  resource limits. Không còn fallback sang đường chạy native không bảo vệ.
- Chặn network, giới hạn cây process/thread, output, workspace write, wall time
  và memory; thêm startup self-test và fail closed khi runner không sẵn sàng.
- Chuẩn hóa verdict TLE/RE/OLE và số liệu time/memory giữa backend và giao diện.
  TLE chỉ hiện một dòng, ẩn exit code nội bộ và hiển thị đúng time limit.
- Sửa giới hạn môi trường compile gây `environment exceeds protocol limits`,
  tăng độ ổn định của compiler watchdog và cache artifact.
- Checker tùy chỉnh portable nhận source C++ hoặc Python; bỏ chạy checker `.exe`
  để tránh sai khác và rủi ro giữa Windows/macOS.

### Desktop và quy trình chấm

- Ngăn WebView tự reload khi Alt+Tab/mất focus và tắt file watcher trong chế độ
  manual desktop test để không restart sidecar ngoài ý muốn.
- Backend chờ startup có retry; đóng app, `Ctrl+C`, End task hoặc Force Quit sẽ
  dọn executor/backend theo đúng parent PID, không kill nhầm phiên khác.
- Nút Judge chỉ bật khi secure runner sẵn sàng và có ít nhất một thí sinh cùng
  một problem được chọn; chọn lại tất cả sau khi bỏ chọn hoạt động bình thường.
- Thứ tự batch judging giữ đúng thứ tự đang hiển thị trên scoreboard.
- Save problem configuration cảnh báo nếu đã có điểm và xóa toàn bộ điểm/log của
  problem sau khi người dùng xác nhận.
- Reload/New contest không tự kích hoạt workspace cũ; đường dẫn lần chọn gần nhất
  chỉ được dùng để prefill hộp chọn thư mục.
- Đồng bộ trạng thái compiler giữa System Status và Compilers & Runtimes Manager.

### Windows và macOS

- Sửa nhận diện executor đã được bundle trong desktop dev và installer.
- macOS dùng `wait4`/`ru_maxrss` cho peak memory và phân loại signal/resource
  limit; hỗ trợ đầy đủ Apple Clang/Xcode SDK trong compiler sandbox; tên bundle
  hiển thị JudgeDesk thay vì ThemisV2.
- CodeMagic Apple Silicon chạy executor unit/security tests và compile-run C++
  thật, xác minh kiến trúc, chữ ký ad-hoc, entitlements, DMG và updater tarball
  trước khi xuất artifact.

### Kiểm thử

- Thêm test executor Rust, security fixtures, boundary TLE/memory lặp 20 lần,
  lifecycle/orphan checks, compiler containment và benchmark JSON/Markdown.
- Đối chiếu 1.060 test với Themis: điểm cấp problem khớp sau quy đổi thang điểm;
  JudgeDesk cho kết quả ổn định hơn trên các test sát ngưỡng thời gian.

## [1.2.0] - 2026-07-19

### Nổi bật

- Đổi tên sản phẩm và thiết kế lại giao diện thành **JudgeDesk**, theo hướng
  desktop workbench gọn hơn trên Windows và macOS.
- Thêm file kỳ thi `.judgedesk`: lưu problems, source thí sinh, cấu hình, lựa
  chọn và toàn bộ kết quả chấm trong một file ZIP portable duy nhất.
- Scoreboard mới tự fit theo cửa sổ lớn, giữ kích thước điều khiển khi cửa sổ
  hẹp, không chọn text trong cell, không hiện dấu ba chấm và hỗ trợ menu chuột
  phải/secondary click cùng nút menu dọc.

### Thêm mới

- Toolbar rút gọn với New/Open/Save contest, Load problems, Load contestants,
  Reload, Judge, Export Excel, Delete selected scores và Update.
- Menu theo cell, problem và contestant cho cấu hình, xóa điểm, chấm lại và xem
  chi tiết; thao tác xóa luôn có bước xác nhận.
- Progress khi lưu contest và cảnh báo Save / Don't save / Cancel khi New,
  Open hoặc đóng app với dữ liệu chưa lưu.
- Chi tiết chấm hiển thị đúng `score / max score` và số test AC hoàn toàn.

### An toàn và tính đúng đắn

- Checker tích hợp và `testlib.h` không còn được cài dưới dạng source có thể sửa.
  App nhúng bản canonical vào binary và tạo một thư mục preview tạm mới mỗi lần
  người dùng chọn View source; bản preview luôn kèm `testlib.h`.
- Bản checker dùng để compile được khôi phục từ dữ liệu nhúng, hoàn toàn tách
  khỏi file preview mà người dùng có thể chỉnh sửa.
- Khóa các thao tác thay đổi contest, cấu hình, điểm và export trong lúc batch
  grading hoặc save contest đang chạy để tránh xung đột trạng thái.
- Bỏ Global time limit; mỗi test dùng time limit trong cấu hình problem/Polygon,
  mặc định 1 giây khi không có cấu hình.
- Sửa tổng điểm Polygon, score tối đa và thống kê test pass trong cửa sổ chi tiết.

### Sửa lỗi

- Sửa đóng app bằng nút X trên Windows và nút đóng cửa sổ trên macOS, bao gồm
  contest trắng, Don't save và sau khi tạo New Contest.
- Ngăn sidecar debug cũ gây lỗi `Access is denied` khó hiểu khi chạy lại app.
- Cải thiện tốc độ tải trạng thái hệ thống ban đầu và vòng đời sidecar.
- Giới hạn tên checker/cột dài để không kéo layout vượt khỏi cửa sổ.

### Nâng cấp

- Giữ nguyên identifier `com.themisv2.judge`, public updater key và endpoint.
  Máy đang chạy `1.1.3` hoặc `1.1.4` có thể cập nhật trực tiếp lên `1.2.0`.
- Giữ nguyên Windows MSI UpgradeCode của ThemisV2 để JudgeDesk thay thế bản cũ
  thay vì cài song song.
- macOS hỗ trợ Apple Silicon, macOS 11 trở lên. Windows hỗ trợ Windows 10/11 x64.

[1.2.0]: https://github.com/ducminh25/themis-v2/releases/tag/v1.2.0
[1.2.1]: https://github.com/ducminh25/themis-v2/releases/tag/v1.2.1
[1.2.2]: https://github.com/ducminh25/themis-v2/releases/tag/v1.2.2
[1.2.3]: https://github.com/ducminh25/themis-v2/releases/tag/v1.2.3
[1.2.4]: https://github.com/ducminh25/themis-v2/releases/tag/v1.2.4
