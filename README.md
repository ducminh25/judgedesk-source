# JudgeDesk

JudgeDesk là ứng dụng chấm bài lập trình cục bộ dành cho kỳ thi và lớp học, với bảng điểm kiểu desktop, cấu hình nhóm test, giao diện sáng/tối và tiếng Anh/tiếng Việt. Ứng dụng hỗ trợ Windows x64 và macOS Apple Silicon.

Trang tải xuống, hướng dẫn cài đặt và hỗ trợ người dùng được duy trì tại repo public [`ducminh25/themis-v2`](https://github.com/ducminh25/themis-v2).

Các thay đổi theo phiên bản được ghi tại [CHANGELOG.md](CHANGELOG.md). Phiên bản
`1.2.0` đổi tên giao diện thành JudgeDesk nhưng giữ nguyên application identifier,
khóa updater và thư mục dữ liệu cũ để người dùng `1.1.3`/`1.1.4` có thể cập nhật
trực tiếp mà không mất cấu hình hoặc toolchain đã cài.

Trên macOS, updater cập nhật bundle tại chỗ và không thể đổi tên thư mục bundle
đang chạy. Vì vậy máy nâng cấp từ bản cũ có thể vẫn chứa
`/Applications/ThemisV2.app` dù cửa sổ và metadata đã mang tên JudgeDesk. Để hoàn
tất đổi tên, thoát ứng dụng, mở DMG JudgeDesk mới, kéo `JudgeDesk.app` vào
Applications, mở bản mới thành công rồi xóa `ThemisV2.app`. Application identifier
và thư mục dữ liệu được giữ nguyên nên thao tác này không xóa cấu hình/toolchain.

## Yêu cầu phát triển

- Node.js đúng dòng `22.x` (các dòng 23+ không được dùng để đóng gói SEA).
- npm, Rust stable và các [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
- Windows: Visual Studio Build Tools với workload **Desktop development with C++**.
- macOS: Xcode Command Line Tools.

G++ và Python hệ thống là tùy chọn. Ở lần mở đầu tiên, người dùng có thể chọn chỉ dùng judger, dùng compiler có sẵn, hoặc để ứng dụng tải toolchain được quản lý và xác thực SHA-256.

## Chạy và kiểm thử

```powershell
npm ci
npm run test:desktop
npm run lint
npm run test:server
npm run build
```

Bộ stress test được chạy với một server đang hoạt động:

```powershell
$env:STRESS_TEST_ROOT='D:\Minh\Code\stress_test_judge'
npm run test:stress
```

Có thể đặt `JUDGE_SERVER_URL` nếu server không chạy tại `http://127.0.0.1:3000`.

## Build desktop và release

```powershell
npm run build:windows:local
```

Sidecar SEA chỉ được build cho kiến trúc của máy hiện tại. Windows x64 có thể
được build và kiểm tra ngay trên máy phát hành; CodeMagic tạo chữ ký updater và
build riêng macOS Apple Silicon, sau đó smoke-test binary và gói cài đặt trên
runner tương ứng.

- Hướng dẫn build: [BUILDING.md](BUILDING.md)
- Ký số, đóng gói MSI/DMG và tạo draft release: [RELEASING.md](RELEASING.md)
- Định dạng file kỳ thi `.judgedesk`: [docs/CONTEST-FORMAT.md](docs/CONTEST-FORMAT.md)

## Lưu ý an toàn

WSL2 + isolate hoặc Docker là tùy chọn. Khi không có sandbox sẵn sàng, bài thi chạy trực tiếp trên máy host; không nên chấm mã nguồn không tin cậy trong chế độ này.

## Cấu trúc chính

- `shared/`: contract và chuẩn hóa cấu hình dùng chung frontend/backend.
- `src/features/`: logic frontend theo tính năng.
- `server/judge/`: compiler, discovery, runner, checker và scoring.
- `server/toolchains/`: resolver, trình cài đặt và kiểm tra tính toàn vẹn compiler/runtime.
- `server/platform/`: dịch vụ phụ thuộc hệ điều hành.
- `server/sandbox/`: phát hiện và điều phối native/WSL/Docker.
- `src-tauri/`: vỏ desktop và vòng đời sidecar.

Xem `CONVERSATION_HISTORY.md` để nắm các quyết định thiết kế và lịch sử phát triển.
