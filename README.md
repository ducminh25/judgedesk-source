# JudgeDesk

JudgeDesk là ứng dụng desktop chấm bài lập trình dành cho kỳ thi và lớp học. Ứng dụng chạy cục bộ trên Windows x64 và macOS Apple Silicon, tích hợp sẵn bảng điểm, cấu hình nhóm test, giao diện sáng/tối và hỗ trợ tiếng Việt/tiếng Anh. Dòng phát hành v1.3 hỗ trợ C++, C, Python, Pascal và Java bằng native secure runner, không fallback âm thầm sang compiler/runtime khác.

Repository này chứa mã nguồn nội bộ của JudgeDesk. Trang công khai dành cho tải
ứng dụng, hướng dẫn cài đặt, release notes và hỗ trợ người dùng được duy trì tại
[`ducminh25/judgedesk`](https://github.com/ducminh25/judgedesk).

## Tài liệu

- **[INSTALL.md](INSTALL.md)**: Hướng dẫn tải và cài đặt cho Windows/macOS.
- **[TOOLCHAINS.md](TOOLCHAINS.md)**: Danh sách và nguồn gốc GCC, Python, Free Pascal và Java do ứng dụng quản lý.
- **[SECURITY.md](SECURITY.md)**: Chính sách bảo mật và cách báo lỗi an toàn.
- **[SUPPORT.md](SUPPORT.md)**: Hướng dẫn báo lỗi và hỗ trợ người dùng.
- **[CHANGELOG.md](CHANGELOG.md)**: Lịch sử cập nhật qua các phiên bản.
- **[BUILDING.md](BUILDING.md)**: Hướng dẫn build từ mã nguồn.
- **[RELEASING.md](RELEASING.md)**: Quy trình đóng gói và phát hành.
- **[docs/CONTEST-FORMAT.md](docs/CONTEST-FORMAT.md)**: Định dạng file kỳ thi `.judgedesk`.
- **[docs/v1.3.1-toolchains-help-implementation-plan.md](docs/v1.3.1-toolchains-help-implementation-plan.md)**: Thiết kế toolchain, flags theo từng bài và Help Center của v1.3.1.
- **[docs/portable-compatibility-v1.3.1.md](docs/portable-compatibility-v1.3.1.md)**: Audit khả năng portable; không phải artefact được hỗ trợ trong v1.3.1.

## Bản phân phối Core và Full

- **Full (khuyến nghị cho giáo viên/phòng thi):** cài xong có sẵn toàn bộ
  managed toolchain được duyệt cho hệ điều hành. Windows còn kèm WebView2
  offline. Trên macOS, Full kèm Python/FPC/Temurin nhưng C/C++ dùng Apple Clang
  và macOS SDK từ Xcode Command Line Tools hoặc Xcode.
- **Core:** chỉ chứa máy chấm và danh mục gói đã ký. Người dùng có thể tải
  managed toolchain từ giao diện hoặc dùng C/C++/Python local đã qua kiểm tra
  tương thích nhanh. Chế độ local ít cô lập hơn là một opt-in có cảnh báo.

Hai biến thể dùng cùng application identity và dữ liệu, vì vậy không cài song
song. Cài Core lên Full hoặc Full lên Core được xem là nâng cấp/thay thế cùng
một JudgeDesk. Full là artifact updater chuẩn để cập nhật không làm mất các
toolchain tích hợp.

## Lưu ý cập nhật từ phiên bản 1.1.x/1.2.x

- Bản `1.3.0` giữ nguyên application identifier và thư mục dữ liệu cũ. Với đợt
  phát hành này, người dùng cũ nhận bộ cài mới trực tiếp thay vì đi qua
  auto-update từ v1.2.7.
- Khi chuyển Core → Full ở v1.3.1, JudgeDesk ghi đè nguồn ngôn ngữ cũ sang các
  package managed đi kèm đúng một lần. Các thay đổi thủ công sau lần bootstrap
  đó vẫn được giữ nguyên.
- Trên macOS, bộ cập nhật tự động cập nhật bundle tại chỗ nên không thể đổi tên thư mục `/Applications/ThemisV2.app` đang chạy. Để hoàn tất đổi tên, bạn có thể tải file `.dmg` mới nhất, kéo `JudgeDesk.app` vào Applications để thay thế bản cũ.

## Môi trường phát triển

- **Node.js**: phiên bản `22.x` (chưa dùng 23+ vì tương thích đóng gói SEA).
- **Rust**: toolchain stable mới nhất cùng các thư viện nền cho [Tauri v2](https://v2.tauri.app/start/prerequisites/).
- **Windows**: Visual Studio Build Tools với workload **Desktop development with C++**.
- **macOS**: Xcode Command Line Tools.

Compiler/runtime trên hệ thống là tùy chọn ở Windows khi dùng Full. Trên macOS,
C/C++ vẫn cần Apple Clang + SDK từ Xcode Command Line Tools hoặc Xcode; các
runtime còn lại có thể dùng gói Full đi kèm, gói managed tải từ repository hoặc
đường dẫn cục bộ phù hợp với policy của từng ngôn ngữ.

## Các lệnh kiểm thử và build

```powershell
npm ci
npm run test:desktop
npm run lint
npm run test:server
npm run build
```

Chạy stress test với server:

```powershell
$env:STRESS_TEST_ROOT='D:\Minh\Code\stress_test_judge'
npm run test:stress
```
*(Nếu server không chạy tại `http://127.0.0.1:3000`, đặt thêm biến môi trường `JUDGE_SERVER_URL`)*

Build hai MSI release candidate trên Windows:

```powershell
npm run build:windows:release:local
```

Các lệnh `build:windows:core:local`, `build:windows:full:local`,
`build:macos:core:local` và `build:macos:full:local` vẫn dùng cho kiểm tra từng
biến thể. Bundle macOS release chính thức phải được tạo bằng workflow
`macos-arm64-release` trên CodeMagic.

## Cấu trúc mã nguồn

- `shared/`: Kiểu dữ liệu và định dạng cấu hình dùng chung giữa frontend và backend.
- `src/features/`: Giao diện và logic frontend theo từng tính năng.
- `server/judge/`: Quản lý compiler, discovery, runner, checker và tính điểm.
- `server/toolchains/`: Tải, xác thực SHA-256 và quản lý toolchain độc lập.
- `server/platform/`: Tương tác với API hệ điều hành (Windows/macOS).
- `server/sandbox/`: Cơ chế cách ly (native, WSL2, Docker).
- `src-tauri/`: Cửa sổ desktop và quản lý tiến trình backend sidecar.
