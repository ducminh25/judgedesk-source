# JudgeDesk

JudgeDesk là ứng dụng desktop chấm bài lập trình cục bộ phục vụ các kỳ thi và lớp học, chạy trên Windows x64 và macOS Apple Silicon (ARM64). Ứng dụng hoạt động offline, hỗ trợ bảng điểm trực tiếp, cấu hình nhóm test, giao diện sáng/tối cùng hai ngôn ngữ giao diện tiếng Việt và tiếng Anh.

Hệ thống chấm hỗ trợ 6 ngôn ngữ: C++, C, Python, Pascal, Java và Scratch (.sb3, .sb2, .sb) thông qua trình thực thi an toàn (native runner) của từng hệ điều hành, không tự động chuyển đổi sang compiler khác khi gặp lỗi cấu hình.

### Mô hình Hai Kho Lưu Trữ (Dual-Repository Model)
- **Mã nguồn & Kỹ thuật:** [`ducminh25/judgedesk-source`](https://github.com/ducminh25/judgedesk-source) — Chứa toàn bộ mã nguồn ứng dụng, runner sandbox an toàn, kiến trúc và pipeline CI/CD. Nơi dành cho lập trình viên và người muốn nghiên cứu, đóng góp hoặc tự build từ mã nguồn.
- **Phân phối chính thức & Hỗ trợ:** [`ducminh25/judgedesk`](https://github.com/ducminh25/judgedesk) — Chứa các bộ cài đặt phát hành chính thức (`.msi`/`.dmg`), mã băm SHA-256, kênh phân phối managed toolchains và tài liệu hỗ trợ người dùng cuối.

## Điểm Nổi Bật (Tính Đến Phiên Bản v1.5.0)

1. **Universal Precompiled Header C++ (`bits/stdc++.h.gch`)**: Tự động sinh và cache PCH cho mọi compiler C++ (Managed GCC, MinGW-w64, MSYS2 UCRT64, Apple Clang) dựa trên canonical path, mtime, size và hash nhận diện, tăng tốc biên dịch lên tới ~16.5 lần.
2. **Chấm Bài Thi Tương Tác (Interactive Problems & Interactor)**: Runner chấm tương tác độc quyền qua Win32 AppContainer dual-job runner với hai đường ống ẩn danh hai chiều (bidirectional anonymous pipes). Hỗ trợ interactor viết bằng C++ (`testlib.h`) hoặc Python.
3. **Chấm Điểm Phân Số Chính Xác Tuyệt Đối (Rational Scoring Engine)**: Tính toán điểm qua phân số tối giản (GCD) triệt tiêu hoàn toàn sai số trôi số thực IEEE 754 trên bảng điểm và xuất Excel.
4. **Nâng Giới Hạn Bộ Nhớ Lên 1024 MB**: Hỗ trợ Memory Limit từ 8 MB đến 1024 MB (1 GB) trên cả Windows và macOS, mặc định 256 MB chuẩn Olympic / HSG / ICPC.
5. **Chấm Thi Scratch Hoàn Thiện Tuyệt Đối**: Runner `scratch-run` (VNOI / TurboWarp VM) tích hợp sẵn, nạp test qua `ask and wait` và xuất kết quả qua `say`/`think`, cô lập an toàn trong Windows Job Objects / macOS Seatbelt.
6. **Làm Ấm Sandbox Ngầm (Background Judge Pre-warm)**: Khởi động nền làm nóng môi trường thực thi và compiler ngay khi mở ứng dụng, loại bỏ độ trễ chấm lần đầu.
7. **Tự Động Di Trú Chính Sách Thực Thi (Toolchain Execution Policy Migration)**: Tự động chuyển đổi các cấu hình toolchain cũ sang chuẩn bảo mật mà không làm gián đoạn người dùng.
8. **In-App Core Updater & Nút Ủng Hộ (Donation)**: Nút cập nhật trực tiếp trên thanh công cụ với tiến trình tải Core ngầm (~20MB) và khởi động lại một chạm; nút ủng hộ / mời cà phê thân thiện.
9. **Bộ Nhận Diện Thương Hiệu Mới**: Logo và biểu tượng ứng dụng thiết kế lại hiện đại, sắc nét trên cả Windows và macOS.

## Bản phân phối Core và Full

JudgeDesk phát hành hai gói cài đặt độc lập:

Bản **Full** tích hợp sẵn toàn bộ trình biên dịch và runtime do ứng dụng quản lý (GCC, CPython, Free Pascal, Eclipse Temurin OpenJDK, Scratch Headless VM). Trên Windows, gói cài đặt chứa cả WebView2 runtime offline. Trên macOS, bản Full đi kèm Python, FPC, Java và Scratch runtime, riêng C/C++ sử dụng Apple Clang từ Xcode Command Line Tools. Đây là bản phù hợp cho phòng thi, máy giáo viên và môi trường không có kết nối mạng.

Bản **Core** chỉ gồm phần mềm chấm thi. Người dùng có thể tải thêm các gói compiler đã ký từ giao diện hoặc chọn compiler có sẵn trên máy sau khi ứng dụng kiểm tra độ tương thích.

Cả hai bản dùng chung định danh ứng dụng và vị trí lưu trữ dữ liệu. Khi có bản cập nhật mới, ứng dụng hỗ trợ cập nhật 1-click siêu tốc (~20MB) trong nền mà không làm mất dữ liệu hay toolchain hiện có.

## Hệ Thống Tài Liệu Kỹ Thuật

Tài liệu dự án được tổ chức chi tiết và chuẩn hóa cho lập trình viên và các AI Agents:

- **[guidelines.md](guidelines.md)**: **Bộ quy chuẩn kỹ thuật toàn diện** (Bắt buộc đọc cho Onboarding Dev & AI Agents) gồm kiến trúc 4 tầng, luồng phát triển hàng ngày, quy chuẩn code C++/TypeScript/Rust, chính sách bảo mật sandbox, quy trình phát hành và danh mục lệnh kiểm thử.
- **[docs/PRD.md](docs/PRD.md)**: Đặc tả yêu cầu sản phẩm (Product Requirements Document) — Mục tiêu, đối tượng người dùng, yêu cầu chức năng (FR-1 đến FR-15) và phi chức năng (NFR).
- **[docs/TRD.md](docs/TRD.md)**: Đặc tả yêu cầu kỹ thuật (Technical Requirements Document) — Kiến trúc 4 tầng, giao thức IPC 16-byte LE, mô hình sandbox đa nền tảng, Universal PCH, giới hạn tài nguyên.
- **[docs/APP_FLOW.md](docs/APP_FLOW.md)**: Sơ đồ tuần tự trực quan (Mermaid Sequence Diagrams) — Khởi động, Handshake, Chấm batch, Bài tương tác, Pre-warm, OSD watcher, Lưu/Mở `.judgedesk`, Xuất Excel `F12`, Fast Update.
- **[docs/BACKEND_SCHEMA.md](docs/BACKEND_SCHEMA.md)**: Đặc tả toàn bộ REST API Endpoints, SSE Streams, Language Profile Contracts, cấu trúc JSON `Config.cfg`, schema `.judgedesk`.
- **[docs/UI_UX_DESIGN.md](docs/UI_UX_DESIGN.md)**: Hệ thống thiết kế Design System (Tailwind CSS v4 tokens, Theme Sáng/Tối, Bảng điểm ma trận, Thông báo lỗi nổi 3 thành phần, Bản đồ phím tắt `F1`-`F12`).
- **[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)**: Kế hoạch triển khai tổng thể & Lịch sử 11 cột mốc phát triển (v1.0.0 đến v1.5.0), hiện trạng kiểm thử toàn diện (>490 tests).
- **[docs/CONTEST-FORMAT.md](docs/CONTEST-FORMAT.md)**: Đặc tả định dạng container file `.judgedesk` (ZIP layout).
- **[docs/scratch-integration.md](docs/scratch-integration.md)**: Hướng dẫn nộp bài & đặc tả kỹ thuật chấm bài Scratch (.sb3, .sb2, .sb).
- **[INSTALL.md](INSTALL.md)**: Hướng dẫn cài đặt và xác minh tệp cài đặt cho Windows và macOS.
- **[TOOLCHAINS.md](TOOLCHAINS.md)**: Danh mục phiên bản compiler/runtime, cờ biên dịch chuẩn, Universal PCH và cơ chế xác thực gói.
- **[SECURITY.md](SECURITY.md)**: Chính sách bảo mật và quy trình báo cáo lỗ hổng an toàn.
- **[SUPPORT.md](SUPPORT.md)**: Quy trình gửi phản hồi và báo lỗi kỹ thuật.
- **[CHANGELOG.md](CHANGELOG.md)**: Lịch sử thay đổi chi tiết theo từng phiên bản.
- **[BUILDING.md](BUILDING.md)**: Thiết lập môi trường và quy trình build từ mã nguồn.
- **[RELEASING.md](RELEASING.md)**: Quy trình đóng gói và xuất bản release 8 assets.

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
$env:STRESS_TEST_ROOT='..\stress_test_judge' # hoặc đường dẫn tới thư mục stress_test_judge
npm run test:stress
```

Đóng gói bộ cài Windows cục bộ:

```powershell
npm run build:windows:release:local
```

Lệnh này tạo hai tệp MSI (Core và Full) trong thư mục `release-assets-windows`. Gói phát hành macOS chính thức được tạo qua pipeline CodeMagic `macos-arm64-release`.

## Cấu trúc mã nguồn

- `shared/`: Định nghĩa kiểu dữ liệu và cấu hình giao tiếp frontend/backend.
- `src/`: Giao diện React 19, các tính năng quản lý bài thi, bảng điểm, toolbar, updater, và Help Center.
- `server/judge/`: Quản lý compiler, Universal PCH (`universal-pch.ts`), background pre-warm, bài tương tác (`interactor-runner.ts`), bộ phát hiện bài làm, cơ chế chấm, checker và tính điểm số hữu tỉ (Rational scoring).
- `server/toolchains/`: Quản lý tải xuống, lưu trữ, di trú chính sách thực thi (`migration.ts`), và xác thực chữ ký SHA-256/Ed25519 cho toolchains.
- `server/platform/`: Tương tác API hệ điều hành (Windows AppContainer / macOS Sandbox, Parent Watchdog).
- `native-executor/`: Module Rust thực thi mã nguồn thí sinh trong môi trường cách ly an toàn (Windows Job Objects / macOS Run Guardian & Seatbelt).
- `src-tauri/`: Cấu hình cửa sổ desktop Tauri v2, single-instance guard, và tiến trình backend sidecar.
