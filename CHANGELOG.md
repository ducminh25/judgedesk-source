# Changelog

Tất cả thay đổi đáng chú ý của JudgeDesk được ghi tại đây. Dự án dùng Semantic
Versioning; các bản `1.x` giữ tương thích updater và dữ liệu ứng dụng hiện có.

## [Unreleased]

## [1.3.3] - 2026-08-13

### Hiệu năng và độ phản hồi

- Giảm mạnh thời gian khởi động Native protection trên Windows khi cache
  toolchain lớn đã có đúng ACL: JudgeDesk kiểm tra policy trước và bỏ qua lượt
  áp quyền đệ quy dư thừa; mọi sai lệch vẫn được sửa theo đường fail-closed cũ.
- Mỗi phiên chấm chỉ quét source thí sinh/test một lần và lưu sẵn cấu hình trọng
  số, điểm tối đa, time limit để dùng lại. Đây không phải tính trước điểm kết
  quả: điểm vẫn chỉ có sau khi bài chạy và checker trả verdict như trước.
- Bảng điểm dùng chỉ mục kết quả, memo hóa từng hàng và gom các progress event
  dày vào frame giao diện mới nhất, giúp cuộn/chấm kỳ thi lớn ổn định hơn.
- Nén/mở kỳ thi `.judgedesk`, tạo workbook Excel và các thao tác toolchain nặng
  được chuyển khỏi luồng giao diện; polling toolchain chậm không còn chồng lặp.

### Xuất Excel

- Nút **Xuất file Excel** sáng khi bảng điểm có ít nhất một thí sinh hoặc một
  bài, kể cả trước khi chấm; các ô và tổng điểm chưa có kết quả là ô trống thật.
- Trên Windows có Microsoft Excel, JudgeDesk mở một workbook `.xlsx` mới chưa
  lưu để `Ctrl+S` hoặc đóng workbook đi qua Save As. Máy không có Excel và
  macOS vẫn giao chính file `.xlsx` cho ứng dụng do hệ điều hành chọn.
- Chặn thao tác xuất trùng trong lúc worker đang tạo file và thay giới hạn cũ
  bằng một giới hạn an toàn 256 MiB cho toàn payload, phù hợp hơn với kỳ thi lớn.

### Nền tảng build

- Khóa release vào Node.js 24.19.0/npm 11.17.0, Rust 1.97.1 và dependency Tauri
  v2 đã cập nhật, đồng thời làm mới các GitHub Action đã pin SHA.
- Không thay đổi hệ điều hành hỗ trợ: Windows 10/11 x64 và macOS 11+ trên Apple
  Silicon; application identifier, dữ liệu người dùng và updater key được giữ nguyên.

## [1.3.2] - 2026-08-10

### Toolchain và trải nghiệm cài đặt

- Full tự chọn lại mọi package managed đi kèm đúng một lần khi cài mới hoặc khi
  thay Core bằng Full; sau bootstrap, lựa chọn thủ công của người dùng tiếp tục
  được tôn trọng. Full → Core tự chuyển nguồn managed không còn tồn tại về tự
  phát hiện local.
- Discovery C/C++/Python chạy nền mỗi lần mở app, ưu tiên đúng thứ tự `PATH`,
  đọc version/vị trí rồi mới thử các đường dẫn chuẩn có giới hạn. API dùng
  snapshot ngay lập tức và không chặn giao diện để launch compiler/runtime.
- Bỏ Verify/Freeze khỏi luồng chính của các profile local nhanh. Strict
  compatibility probe vẫn là mặc định; công tắc Advanced resource-only phải do
  người dùng chủ động bật và vẫn giữ TLE/MLE/process-tree cleanup, nhưng không
  cô lập filesystem/network.
- Full macOS tiếp tục dùng Apple Clang + macOS SDK từ Xcode Command Line Tools
  hoặc Xcode cho C/C++; Python, FPC và Temurin ARM64 là các package đi kèm.
- Smoke gate Apple Silicon chờ strict compatibility probe hoàn tất trong thời
  hạn hữu hạn thay vì báo lỗi ngay khi trạng thái còn đang được kiểm tra.

### Cấu hình bài và hướng dẫn

- Thêm cấu hình biên dịch riêng từng bài trong `Config.cfg`: `Tương thích
  Themis` (mặc định), `Hiện đại (tham khảo IOI/ICPC 2025)`, `ICPC World Finals`
  và `Tùy chỉnh`. Flags được lưu dưới dạng argv snapshot; các override source,
  output, plugin, toolchain root và linker nguy hiểm bị chặn.
- Thêm Help Center offline song ngữ, tìm kiếm, phím F1, nút Hướng dẫn bên trái
  updater và phần About/chẩn đoán sản phẩm trong cùng một cửa sổ.
- Audit khả năng portable được ghi lại riêng; v1.3.2 vẫn chỉ hỗ trợ installer
  Windows và disk image macOS, không phát hành ZIP/SFX portable.

## [1.3.0] - 2026-08-01

### Chấm bài đa ngôn ngữ

- Bổ sung registry có version cho C++, C, Python, Pascal và Java; mỗi ngôn ngữ
  công khai rõ trạng thái `Không tìm thấy`, `Chỉ dùng để dịch máy chấm` hoặc
  `Sẵn sàng chấm` và không fallback âm thầm khi nguồn đã chọn không khả dụng.
- Thêm lựa chọn nguồn cố định `None`, `Managed by toolchain`, `Local (path)` và
  `Local (auto-detect)`. Auto-detect nhanh chỉ tự chạy trong lần thiết lập đầu;
  các lần sau người dùng chủ động bấm quét lại.
- C và C++ giữ bộ cờ thi đấu tương thích Themis theo từng nền tảng; Python chạy
  qua managed interpreter khi chấm submission; Pascal dùng FPC và Java dùng
  Temurin JDK đã ghim phiên bản.
- Custom checker C++ và Python đi qua cùng native secure executor, giới hạn tài
  nguyên và cleanup contract như submission; syntax-check và execution của
  checker Python được khóa vào cùng managed runtime đã xác minh.

### Core, Full và managed toolchain

- Phát hành riêng Core và Full cho Windows x64 và macOS Apple Silicon. Full
  tích hợp toàn bộ managed package được duyệt; Core tải đúng các gói đã ký từ
  public repository khi cần.
- Thêm manifest v2 ký Ed25519, SHA-256 bắt buộc, metadata package nghiêm ngặt,
  chống path traversal/symlink escape và probe thật trước khi gói được đánh dấu
  sẵn sàng.
- Windows Full kèm GCC 14.2, Python 3.12.13, FPC 3.2.2, Temurin 21 và WebView2
  offline. macOS Full kèm Python/FPC/Temurin ARM64; C/C++ dùng Apple Clang đã
  kiểm tra nhanh từ Xcode Command Line Tools.
- Tối ưu clone cache compiler/runtime và snapshot nội bộ để giảm overhead mỗi
  lượt chấm mà vẫn giữ workspace, quyền thực thi và package identity tách biệt.

### Native protection và vòng đời tiến trình

- Hoàn thiện single-instance: mở JudgeDesk lần hai sẽ chuyển focus về cửa sổ
  đang chạy thay vì tạo thêm backend hoặc lượt chấm chồng chéo.
- Siết giám sát backend, process group và run guardian trên macOS; fail closed
  khi không thiết lập được containment, cleanup hoặc generation guard.
- Mở rộng secure execution cho C, Pascal và Java; chuẩn hóa timeout khởi động
  compiler lạnh, chẩn đoán lỗi guardian và cleanup sau hủy/chấm xong.
- Sửa các trường hợp FPC/macOS cần đúng SDK, linker script và utility hệ thống;
  giảm false positive Defender từ binary Pascal mà không nới sandbox.

### Giao diện và vận hành

- Thêm màn hình quản lý compiler/runtime và thiết lập lần đầu bằng tiếng
  Việt/tiếng Anh, với thao tác cài, áp dụng, gỡ managed package hoặc chọn đường
  dẫn local rõ ràng.
- Nút kiểm tra/tải bản cập nhật trên toolbar có chữ hiển thị trực tiếp, vùng bấm
  lớn hơn, tiến độ tải, trạng thái lỗi và thao tác thử lại dễ nhận biết.
- Sửa discovery snapshot bị cũ sau khi cài Full, đường dẫn resource Windows và
  giá trị mặc định để năm ngôn ngữ sẵn sàng ngay sau cài đặt hợp lệ.

### Repository, phát hành và kiểm thử

- Chuyển mã nguồn sang repository private `ducminh25/judgedesk-source`; giữ
  `ducminh25/judgedesk` làm repository công khai cho bộ cài, hướng dẫn, hỗ trợ,
  updater manifest và managed toolchain.
- Workflow toolchain v2 phát hành chéo bằng credential riêng; release pipeline
  tạo Core/Full có tên artifact riêng và chỉ dùng Full làm updater chuẩn.
- Bổ sung gate thật cho package, C/Pascal/Java/Python, custom checker, resource
  limit, single-instance, macOS process supervisor và packaged Full app.

## [1.2.7] - 2026-07-27

### Ổn định Python được quản lý trên macOS

- Tôn trọng đúng nguồn Python đang được chọn: System/Custom Python chỉ phục vụ
  trusted checker, còn submission chỉ báo sẵn sàng khi Managed Python thực sự
  được chọn và có thể chạy trong sandbox.
- Đưa toàn bộ managed Python package vào executor cache tự chứa, viết lại các
  symbolic link nội bộ sau khi copy và xử lý đúng alias đường dẫn tạm
  `/var`/`/private/var` trên macOS.
- Siết kiểm tra containment theo đường dẫn canonical: chấp nhận symlink hợp lệ
  nằm trong toolchain nhưng từ chối link thoát khỏi thư mục cài đặt/cache.
- Thêm release smoke test cài Managed Python thật, import runtime vào native
  executor và chạy compile-and-run submission Python trên Apple Silicon.

### Reload và phát hiện test

- Reload giữ nguyên trạng thái đã tick/bỏ tick của thí sinh và problem hiện có;
  mục mới phát hiện được chọn mặc định, mục đã bị xóa được loại khỏi trạng thái.
- Chỉ nhận thư mục test có đủ file input `.inp/.in` và expected output
  `.out/.ans`. Các thư mục phụ như `__pycache__`, thư mục rỗng hoặc thiếu một
  phía không còn xuất hiện trên giao diện hay bị cộng nhầm vào tổng trọng số.
- Giao diện cấu hình problem và judge engine dùng chung một quy tắc discovery,
  giữ kết quả nhất quán trên Windows và macOS.

### Kiểm thử

- Bổ sung regression tests cho selection khi Reload, managed Python cache,
  archive symlink/containment và testcase discovery đa nền tảng.
- CI xác nhận typecheck, toàn bộ server tests, frontend/backend build và Tauri
  shell trên Windows 2022 và macOS 15.

## [1.2.6] - 2026-07-26

### Hợp nhất Repository & Phát hành Công khai (Public Release)

- Chuyển mã nguồn chính thức sang repository công khai `ducminh25/judgedesk`.
- Nhập toàn bộ tài liệu người dùng (`INSTALL.md`, `SECURITY.md`, `SUPPORT.md`, `TOOLCHAINS.md`), mẫu báo cáo lỗi và workflow đóng gói toolchain từ kho cũ.
- Cập nhật đường dẫn tra cứu bản cập nhật ứng dụng (`latest.json`), URL tải về managed toolchain (`toolchains-v1`), và các liên kết hỗ trợ về kho lưu trữ mới `ducminh25/judgedesk`.

### Sửa lỗi chấm bài Python trên macOS

- Khắc phục lỗi chọn nhầm System Python gây lỗi `TOOLCHAIN_NOT_SANDBOX_COMPATIBLE` (CE toàn bộ) khi chấm bài Python bằng Managed Toolchain trong sandbox macOS.
- Sửa lỗi xác định cache managed Python trên macOS (`bin/python3` symlink), đồng thời bổ sung kiểm tra `realpath` ngăn chặn directory traversal.
- Bổ sung quy tắc `process-exec` cho thư mục `toolchain_root` trong cấu hình Seatbelt sandbox, cho phép thi hành trình thông dịch Python trong managed runtime mà không bị từ chối quyền.
- Bảo toàn tuyệt đối các cơ chế bảo mật: chặn mạng, chặn giới hạn tiến trình/luồng (forkbomb), từ chối thực thi cmd/shell và cách ly tệp trong workspace.

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

[1.2.0]: https://github.com/ducminh25/judgedesk/releases/tag/v1.2.0
[1.2.1]: https://github.com/ducminh25/judgedesk/releases/tag/v1.2.1
[1.2.2]: https://github.com/ducminh25/judgedesk/releases/tag/v1.2.2
[1.2.3]: https://github.com/ducminh25/judgedesk/releases/tag/v1.2.3
[1.2.4]: https://github.com/ducminh25/judgedesk/releases/tag/v1.2.4
[1.2.6]: https://github.com/ducminh25/judgedesk/releases/tag/v1.2.6
[1.2.7]: https://github.com/ducminh25/judgedesk/releases/tag/v1.2.7
[1.3.0]: https://github.com/ducminh25/judgedesk/releases/tag/v1.3.0
[1.3.2]: https://github.com/ducminh25/judgedesk/releases/tag/v1.3.2
[1.3.3]: https://github.com/ducminh25/judgedesk/releases/tag/v1.3.3
