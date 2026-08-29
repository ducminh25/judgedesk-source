# JudgeDesk

JudgeDesk là ứng dụng desktop chấm bài lập trình cục bộ phục vụ các kỳ thi và lớp học, chạy trên Windows x64 và macOS Apple Silicon (ARM64). Ứng dụng hoạt động offline, hỗ trợ bảng điểm trực tiếp, cấu hình nhóm test, giao diện sáng/tối cùng hai ngôn ngữ giao diện tiếng Việt và tiếng Anh.

Hệ thống chấm hỗ trợ 6 ngôn ngữ: C++, C, Python, Pascal, Java và Scratch (.sb3, .sb2, .sb) thông qua trình thực thi an toàn (native runner) của từng hệ điều hành, không tự động chuyển đổi sang compiler khác khi gặp lỗi cấu hình.

Mã nguồn chính thức được lưu trữ tại [`ducminh25/judgedesk`](https://github.com/ducminh25/judgedesk).

## Bản phân phối Core và Full

JudgeDesk phát hành hai gói cài đặt độc lập:

Bản **Full** tích hợp sẵn toàn bộ trình biên dịch và runtime do ứng dụng quản lý (GCC, CPython, Free Pascal, Eclipse Temurin OpenJDK, Scratch Headless VM). Trên Windows, gói cài đặt chứa cả WebView2 runtime offline. Trên macOS, bản Full đi kèm Python, FPC, Java và Scratch runtime, riêng C/C++ sử dụng Apple Clang từ Xcode Command Line Tools. Đây là bản phù hợp cho phòng thi, máy giáo viên và môi trường không có kết nối mạng.

Bản **Core** chỉ gồm phần mềm chấm thi. Người dùng có thể tải thêm các gói compiler đã ký từ giao diện hoặc chọn compiler có sẵn trên máy sau khi ứng dụng kiểm tra độ tương thích.

Cả hai bản dùng chung định danh ứng dụng và vị trí lưu trữ dữ liệu. Khi có bản cập nhật mới, ứng dụng hỗ trợ cập nhật 1-click siêu tốc (~20MB) trong nền mà không làm mất dữ liệu hay toolchain hiện có.

## Tài liệu hướng dẫn

- **[INSTALL.md](INSTALL.md)**: Hướng dẫn cài đặt và xác minh tệp cài đặt cho Windows và macOS.
- **[TOOLCHAINS.md](TOOLCHAINS.md)**: Danh mục phiên bản compiler/runtime, cờ biên dịch chuẩn và cơ chế xác thực gói.
- **[SECURITY.md](SECURITY.md)**: Chính sách bảo mật và quy trình báo cáo lỗ hổng an toàn.
- **[SUPPORT.md](SUPPORT.md)**: Quy trình gửi phản hồi và báo lỗi kỹ thuật.
- **[CHANGELOG.md](CHANGELOG.md)**: Lịch sử thay đổi chi tiết theo từng phiên bản.
- **[BUILDING.md](BUILDING.md)**: Thiết lập môi trường và quy trình build từ mã nguồn.
- **[RELEASING.md](RELEASING.md)**: Quy trình đóng gói và xuất bản release.
- **[docs/CONTEST-FORMAT.md](docs/CONTEST-FORMAT.md)**: Đặc tả cấu trúc tệp kỳ thi `.judgedesk`.

## Môi trường phát triển

- **Node.js**: `24.19.0` (kèm npm `11.17.0`, quản lý qua `.nvmrc` hoặc Volta).
- **Rust**: `1.97.1` (khóa qua `rust-toolchain.toml`).
- **Tauri**: CLI v2 theo lockfile dự án.
- **Windows**: Visual Studio C++ Build Tools và WebView2 Runtime.
- **macOS**: Xcode Command Line Tools (`xcode-select --install`).

## Lệnh kiểm thử và build

Cài đặt dependencies và chạy kiểm thử tự động:

```powershell
npm ci
npm run lint
npm run test:server
npm run test:desktop
```

Chạy stress test kiểm tra tải chấm:

```powershell
$env:STRESS_TEST_ROOT='D:\Minh\Code\stress_test_judge'
npm run test:stress
```

Đóng gói bộ cài Windows cục bộ:

```powershell
npm run build:windows:release:local
```

Lệnh này tạo hai tệp MSI (Core và Full) trong thư mục `release-assets-windows`. Gói phát hành macOS chính thức được tạo qua pipeline CodeMagic `macos-arm64-release`.

## Cấu trúc mã nguồn

- `shared/`: Định nghĩa kiểu dữ liệu và cấu hình giao tiếp frontend/backend.
- `src/`: Giao diện React, các tính năng quản lý bài thi, bảng điểm và Help Center.
- `server/judge/`: Quản lý compiler, bộ phát hiện bài làm, cơ chế chấm, checker và tính điểm.
- `server/toolchains/`: Quản lý tải xuống, lưu trữ và xác thực chữ ký SHA-256/Ed25519 cho toolchains.
- `server/platform/`: Tương tác API hệ điều hành (Windows AppContainer / macOS Sandbox).
- `native-executor/`: Module Rust thực thi mã nguồn thí sinh trong môi trường cách ly an toàn.
- `src-tauri/`: Cấu hình cửa sổ desktop Tauri và tiến trình backend sidecar.
