# JudgeDesk

JudgeDesk là ứng dụng desktop chấm bài lập trình dành cho kỳ thi và lớp học. Ứng dụng chạy cục bộ trên Windows x64 và macOS Apple Silicon, tích hợp sẵn bảng điểm, cấu hình nhóm test, giao diện sáng/tối và hỗ trợ tiếng Việt/tiếng Anh.

Trang tải xuống, hướng dẫn cài đặt, hỗ trợ người dùng và mã nguồn chính thức được duy trì tại repository [`ducminh25/judgedesk`](https://github.com/ducminh25/judgedesk).

## Tài liệu

- **[INSTALL.md](INSTALL.md)**: Hướng dẫn tải và cài đặt cho Windows/macOS.
- **[TOOLCHAINS.md](TOOLCHAINS.md)**: Danh sách và nguồn gốc bộ dịch (GCC, Python) do ứng dụng quản lý.
- **[SECURITY.md](SECURITY.md)**: Chính sách bảo mật và cách báo lỗi an toàn.
- **[SUPPORT.md](SUPPORT.md)**: Hướng dẫn báo lỗi và hỗ trợ người dùng.
- **[CHANGELOG.md](CHANGELOG.md)**: Lịch sử cập nhật qua các phiên bản.
- **[BUILDING.md](BUILDING.md)**: Hướng dẫn build từ mã nguồn.
- **[RELEASING.md](RELEASING.md)**: Quy trình đóng gói và phát hành.
- **[docs/CONTEST-FORMAT.md](docs/CONTEST-FORMAT.md)**: Định dạng file kỳ thi `.judgedesk`.

## Lưu ý cập nhật từ phiên bản 1.1.x (ThemisV2)

- Các bản `1.2.x` giữ nguyên application identifier, khóa updater và thư mục dữ liệu cũ để người dùng các bản 1.1.x có thể cập nhật trực tiếp mà không mất cấu hình hoặc toolchain đã cài.
- Trên macOS, bộ cập nhật tự động cập nhật bundle tại chỗ nên không thể đổi tên thư mục `/Applications/ThemisV2.app` đang chạy. Để hoàn tất đổi tên, bạn có thể tải file `.dmg` mới nhất, kéo `JudgeDesk.app` vào Applications để thay thế bản cũ.

## Môi trường phát triển

- **Node.js**: phiên bản `22.x` (chưa dùng 23+ vì tương thích đóng gói SEA).
- **Rust**: toolchain stable mới nhất cùng các thư viện nền cho [Tauri v2](https://v2.tauri.app/start/prerequisites/).
- **Windows**: Visual Studio Build Tools với workload **Desktop development with C++**.
- **macOS**: Xcode Command Line Tools.

G++ và Python trên hệ thống là tùy chọn; khi sử dụng, người dùng có thể chọn compiler có sẵn trên máy hoặc để ứng dụng tải bộ toolchain độc lập.

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

Build ứng dụng desktop cục bộ:

```powershell
npm run build:windows:local
```

## Cấu trúc mã nguồn

- `shared/`: Kiểu dữ liệu và định dạng cấu hình dùng chung giữa frontend và backend.
- `src/features/`: Giao diện và logic frontend theo từng tính năng.
- `server/judge/`: Quản lý compiler, discovery, runner, checker và tính điểm.
- `server/toolchains/`: Tải, xác thực SHA-256 và quản lý toolchain độc lập.
- `server/platform/`: Tương tác với API hệ điều hành (Windows/macOS).
- `server/sandbox/`: Cơ chế cách ly (native, WSL2, Docker).
- `src-tauri/`: Cửa sổ desktop và quản lý tiến trình backend sidecar.
