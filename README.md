# JudgeDesk

JudgeDesk là ứng dụng desktop chấm bài lập trình cục bộ phục vụ các kỳ thi và lớp học, chạy gốc (native) trên **Windows 10/11 x64**, **macOS Apple Silicon (ARM64, macOS 11+)** và **Linux x86_64 (`amd64` — Ubuntu 22.04 LTS, 24.04 LTS, 26.04 LTS+ và các distro tương thích)**. Ứng dụng hoạt động 100% offline khi chấm thi, hỗ trợ bảng điểm trực tiếp, cấu hình nhóm test (Subtasks), chấm bài tương tác (Interactive), trung tâm thông báo chính thức có chữ ký số (Notification Center), giao diện sáng/tối cùng hai ngôn ngữ giao diện tiếng Việt và tiếng Anh.

Hệ thống chấm hỗ trợ 6 ngôn ngữ: **C++, C, Python, Pascal, Java và Scratch (`.sb3`, `.sb2`, `.sb`)** thông qua trình thực thi an toàn (native sandbox runner) của từng hệ điều hành, không tự động chuyển đổi sang compiler khác khi gặp lỗi cấu hình.

### Mô hình Hai Kho Lưu Trữ (Dual-Repository Model)
- **Mã nguồn & Kỹ thuật:** [`ducminh25/judgedesk-source`](https://github.com/ducminh25/judgedesk-source) — Chứa toàn bộ mã nguồn ứng dụng, Pure Rust Core (`judgedesk-core`), runner sandbox an toàn (`native-executor`), kiến trúc và pipeline CI/CD. Nơi dành cho lập trình viên và người muốn nghiên cứu, đóng góp hoặc tự build từ mã nguồn.
- **Phân phối chính thức & Hỗ trợ:** [`ducminh25/judgedesk`](https://github.com/ducminh25/judgedesk) — Chứa các bộ cài đặt phát hành chính thức (`.msi`, `.dmg`, `.deb`, `.rpm`, `.AppImage`), mã băm `SHA256SUMS`, kênh phân phối managed toolchains và tài liệu hỗ trợ người dùng cuối.

## Nền Tảng Hỗ Trợ & Các Loại Tệp Cài Đặt (v1.6.1)

| Hệ điều hành | Phiên bản hỗ trợ | Định dạng & Tên tệp cài đặt (`v1.6.1`) | Bản phân phối & Đặc điểm |
| :--- | :--- | :--- | :--- |
| **Windows x64** | Windows 10, Windows 11 (64-bit) | `JudgeDesk_1.6.1_full_x64_en-US.msi`<br/>`JudgeDesk_1.6.1_core_x64_en-US.msi` | **Full**: Tích hợp sẵn GCC 14, Python 3.12, Free Pascal, OpenJDK 21, Scratch VM & WebView2 offline.<br/>**Core**: Bản rút gọn, tự nhận diện compiler trên máy hoặc tải gói ký số từ trong app. |
| **macOS Apple Silicon** | macOS 11 Big Sur trở lên (`arm64` — M1/M2/M3/M4) | `JudgeDesk_1.6.1_full_aarch64.dmg`<br/>`JudgeDesk_1.6.1_core_aarch64.dmg`<br/>*(kèm `.app.tar.gz` cho in-app updater)* | **Full**: Đóng gói sẵn Python 3.12, Free Pascal, OpenJDK 21, Scratch VM; C/C++ dùng Apple Clang (`xcode-select --install`).<br/>**Core**: Bản rút gọn dùng compiler hệ thống hoặc tải gói managed. |
| **Linux x86_64 (`amd64`) — Ubuntu / Debian / Mint** | **Ubuntu 22.04 LTS, 24.04 LTS, 26.04 LTS+**<br/>Debian 12+, Linux Mint 21+, Pop!_OS 22.04+, Zorin OS 17+ *(GLIBC $\ge$ 2.34)* | `JudgeDesk_1.6.1_full_amd64.deb`<br/>`JudgeDesk_1.6.1_amd64.deb` *(Core)* | **Full**: Đóng gói sẵn toàn bộ 6 ngôn ngữ offline (GCC 14.2, Python 3.12, Free Pascal 3.2.2, Temurin JDK 21, Scratch 0.1.7).<br/>**Core**: Tự động nhận diện mọi phiên bản compiler trên hệ thống kèm Scratch tích hợp sẵn. |
| **Linux x86_64 (`amd64`) — Fedora / RHEL / openSUSE** | Fedora 38+, RHEL / AlmaLinux / Rocky 9+, openSUSE Leap / Tumbleweed *(GLIBC $\ge$ 2.34)* | `JudgeDesk-1.6.1-full-1.x86_64.rpm`<br/>`JudgeDesk-1.6.1-1.x86_64.rpm` *(Core)* | **Full**: Đóng gói sẵn toàn bộ 6 ngôn ngữ offline.<br/>**Core**: Tự động nhận diện `g++`/`clang++`, `python3`, `fpc`, `javac` trên máy kèm Scratch tích hợp sẵn. |
| **Linux x86_64 (`amd64`) — Đa bản phân phối (Portable)** | Hầu hết các bản phân phối Linux 64-bit (`x86_64`, *GLIBC $\ge$ 2.34*, có `libfuse2` + `bubblewrap`) | `JudgeDesk_1.6.1_full_amd64.AppImage`<br/>`JudgeDesk_1.6.1_amd64.AppImage` *(Core)* | Tệp thực thi độc lập (`chmod +x ./JudgeDesk_1.6.1_*.AppImage && ./JudgeDesk_1.6.1_*.AppImage`), hỗ trợ cả bản **Full** (đủ 6 ngôn ngữ offline) và **Core**. |

### Cài Đặt Nhanh Trên Từng Hệ Điều Hành

- **Windows 10/11 x64**: Chạy tệp `.msi` (`Full` hoặc `Core`). Bộ cài tự động nâng cấp tại chỗ nếu máy đã có phiên bản cũ.
- **macOS Apple Silicon**: Mở tệp `.dmg`, kéo `JudgeDesk.app` vào `Applications`, sau đó chạy `xattr -dr com.apple.quarantine /Applications/JudgeDesk.app` trong Terminal trước lần mở đầu tiên.
- **Linux (Ubuntu 22.04 LTS / 24.04 LTS / 26.04 LTS+ / Debian / Mint)**:
  ```bash
  sudo apt update
  sudo apt install ./JudgeDesk_1.6.1_full_amd64.deb   # hoặc JudgeDesk_1.6.1_amd64.deb (bản Core)
  ```
- **Linux (Fedora / RHEL / openSUSE)**:
  ```bash
  sudo dnf install ./JudgeDesk-1.6.1-full-1.x86_64.rpm   # hoặc JudgeDesk-1.6.1-1.x86_64.rpm (bản Core)
  ```
- **Linux (AppImage)**:
  ```bash
  chmod +x ./JudgeDesk_1.6.1_full_amd64.AppImage
  ./JudgeDesk_1.6.1_full_amd64.AppImage
  ```

## Điểm Nổi Bật (Tính Đến Phiên Bản v1.6.1)

1. **Hỗ Trợ Chính Thức Linux Đa Phiên Bản (`Ubuntu 22.04 LTS+`, Đủ Bản `Full` & `Core` cho `.deb` / `.rpm` / `.AppImage`) & Pure Rust Core**:
   - Phát hành đầy đủ cả **Bản Full** (đóng gói sẵn toàn bộ 6 ngôn ngữ offline gồm xPack GCC 14.2.0-2 kèm binutils/sysroot, CPython 3.12.13, Free Pascal 3.2.2, Eclipse Temurin JDK 21.0.12+8 và `scratch-run` 0.1.7, tự động xác minh chỉ mục `SHA-256` từng tệp và nhập vào cache ngay lần chạy đầu tiên mà không cần mạng) và **Bản Core** (nhẹ gọn, tự động nhận diện mọi phiên bản compiler trên hệ thống kèm Scratch tích hợp sẵn) cho cả 3 định dạng `.deb`, `.rpm` và `.AppImage`.
   - Tích hợp backend `judgedesk-core` (Rust Axum) hiệu năng cao song hành cùng kiến trúc sidecar và `judgedesk-native-executor`.
   - Cô lập thực thi bài nộp trên Linux bằng **Bubblewrap (`bwrap`) + systemd User Scope (`cgroup v2`) + bộ lọc syscall `seccomp-bpf`**, chặn hoàn toàn mạng, ánh xạ đường dẫn ngắn (`/jd-tools`, `/jd-work`) giúp Free Pascal biên dịch ổn định với đường dẫn dài và cô lập hệ thống tệp mà không yêu cầu quyền `root` khi chấm bài.
   - Binary Linux được liên kết tương thích chuẩn ELF `GLIBC <= 2.34`, chạy mượt từ **Ubuntu 22.04 LTS**, **Ubuntu 24.04 LTS** đến **Ubuntu 26.04 LTS+** và các distro hiện đại mà không bị khoá cứng phiên bản thư viện hay phiên bản GCC/Python.
2. **Trung Tâm Thông Báo Admin Có Chữ Ký Số (`Signed Admin Announcements & Notification Center`)**:
   - Tích hợp biểu tượng chuông thông báo trên thanh công cụ với badge số tin chưa đọc, bảng tin neo trực tiếp (`Popover`) và hộp thoại đọc bài báo dạng editorial (hỗ trợ Tiếng Việt & Tiếng Anh).
   - Nhận bản tin, hướng dẫn và thông báo quan trọng qua kênh phân phối tĩnh được ký số bằng khoá **Ed25519** độc lập (`announcements-v1`), bảo vệ chống tấn công hạ cấp (`sequence` high-water mark), lọc mã HTML an toàn, kiểm tra `SHA-256` và giải mã ảnh trực tiếp trong nhân Rust (`src-tauri`), lưu trữ bộ nhớ đệm đọc offline mà không ảnh hưởng tới quá trình chấm thi.
3. **In-App Updater Cách Ly Đúng Định Dạng Gói Cài Đặt (Format-Isolated Updater)**:
   - Trên Windows và macOS, trình cập nhật tải gói Core nhẹ (~20MB) để cập nhật nhanh trong nền và giữ nguyên toàn bộ dữ liệu + toolchains.
   - Trên Linux, trình cập nhật tự động nhận diện định dạng cài đặt gốc (`deb`, `rpm`, hoặc `appimage`) qua manifest mục tiêu riêng (`linux-x86_64-deb-core`/`full`, `linux-x86_64-rpm-core`/`full`, `linux-x86_64-appimage-core`/`full`), đảm bảo người dùng cài `.rpm` hoặc `.AppImage` luôn tải đúng định dạng tương ứng khi cập nhật, tuyệt đối không tải nhầm `.deb`.
4. **Universal Precompiled Header C++ (`bits/stdc++.h.gch`)**: Tự động sinh và cache PCH cho mọi compiler C++ (Managed GCC, MinGW-w64, MSYS2 UCRT64, Apple Clang, Linux GCC/Clang) dựa trên canonical path, mtime, size và hash nhận diện, tăng tốc biên dịch lên tới ~16.5 lần.
5. **Chấm Bài Thi Tương Tác Đa Nền Tảng (Interactive Problems & Interactor)**: Hỗ trợ chấm bài tương tác hai chiều trên cả Windows (`windows_job`), macOS (`macos_seatbelt`) và Linux (`linux_interactive`) với hai đường ống ẩn danh hai chiều (bidirectional anonymous pipes), chống deadlock `EOF`/`SIGPIPE` và hỗ trợ interactor viết bằng C++ (`testlib.h`) hoặc Python.
6. **Chấm Điểm Phân Số Chính Xác Tuyệt Đối (Rational Scoring Engine)**: Tính toán điểm qua phân số tối giản (GCD) triệt tiêu hoàn toàn sai số trôi số thực IEEE 754 trên bảng điểm và xuất Excel.
7. **Nâng Giới Hạn Bộ Nhớ Lên 1024 MB**: Hỗ trợ Memory Limit từ 8 MB đến 1024 MB (1 GB) trên cả Windows, macOS và Linux, mặc định 256 MB chuẩn Olympic / HSG / ICPC.
8. **Chấm Thi Scratch Hoàn Thiện Tuyệt Đối**: Runner `scratch-run` (VNOI / TurboWarp VM) tích hợp sẵn, nạp test qua `ask and wait` và xuất kết quả qua `say`/`think`, cô lập an toàn trong OS Sandbox.
9. **Làm Ấm Sandbox Ngầm (Background Judge Pre-warm)**: Khởi động nền làm nóng môi trường thực thi và compiler ngay khi mở ứng dụng, loại bỏ độ trễ chấm lần đầu.
10. **Tự Động Nhận Diện & Di Trú Chính Sách Thực Thi (Toolchain Auto-Discovery & Policy Migration)**: Tự động phát hiện mọi phiên bản `g++`/`gcc`/`clang++`, `python3`, `fpc`, `javac` hợp lệ trên máy và chuyển đổi các cấu hình cũ sang chuẩn bảo mật mà không làm gián đoạn người dùng.

## Bản phân phối Core và Full

JudgeDesk cung cấp đầy đủ hai phiên bản **Full** và **Core** trên cả 3 hệ điều hành:

- **Bản Full (Windows `.msi`, macOS `.dmg` & Linux `.deb` / `.rpm` / `.AppImage`)**: Tích hợp sẵn trình biên dịch và runtime do ứng dụng quản lý (GCC 14.2, CPython 3.12, Free Pascal 3.2.2, Eclipse Temurin OpenJDK 21, Scratch Headless VM 0.1.7). Trên Windows, gói cài đặt chứa cả WebView2 runtime offline. Trên macOS, bản Full đi kèm Python, FPC, Java và Scratch runtime, riêng C/C++ sử dụng Apple Clang từ Xcode Command Line Tools. Trên Linux (`_full_amd64.deb`, `-full-1.x86_64.rpm`, `_full_amd64.AppImage`), toàn bộ 6 ngôn ngữ được đóng gói sẵn kèm chỉ mục xác thực `SHA-256` từng tệp và tự động kích hoạt ngay lần khởi chạy đầu tiên mà không cần mạng. Đây là bản khuyên dùng cho phòng thi, máy giáo viên và môi trường offline hoàn toàn.
- **Bản Core (Windows `.msi`, macOS `.dmg` & Linux `.deb` / `.rpm` / `.AppImage`)**: Chỉ gồm phần mềm chấm thi và Scratch Headless VM tích hợp sẵn. Trên Linux (`.deb` Core), trình quản lý gói `apt` tự động cài đặt `g++`, `python3`, `bubblewrap`, `zenity` cùng lúc với ứng dụng, và JudgeDesk tự động nhận diện ngay các trình biên dịch hệ thống ở chế độ `Local (auto-detect)` mà không cần cấu hình đường dẫn thủ công. Người dùng trên Windows/macOS cũng có thể tải thêm các gói compiler đã ký từ giao diện `F6` hoặc chọn compiler có sẵn trên máy.

Mọi bản cài đặt trên cùng hệ điều hành dùng chung định danh ứng dụng (`com.themisv2.judge`) và vị trí lưu trữ dữ liệu (`%LOCALAPPDATA%\ThemisV2` trên Windows, `~/Library/Application Support/ThemisV2` trên macOS, `~/.local/share/ThemisV2` trên Linux).

## Hệ Thống Tài Liệu Kỹ Thuật

Tài liệu dự án được tổ chức chi tiết và chuẩn hóa cho lập trình viên và các AI Agents:

- **[guidelines.md](guidelines.md)**: **Bộ quy chuẩn kỹ thuật toàn diện** (Bắt buộc đọc cho Onboarding Dev & AI Agents) gồm kiến trúc 4 tầng, luồng phát triển hàng ngày, quy chuẩn code C++/TypeScript/Rust, chính sách bảo mật sandbox (Windows/macOS/Linux), quy trình phát hành và danh mục lệnh kiểm thử.
- **[docs/PRD.md](docs/PRD.md)**: Đặc tả yêu cầu sản phẩm (Product Requirements Document) — Mục tiêu, đối tượng người dùng, yêu cầu chức năng (FR-1 đến FR-15) và phi chức năng (NFR).
- **[docs/TRD.md](docs/TRD.md)**: Đặc tả yêu cầu kỹ thuật (Technical Requirements Document) — Kiến trúc 4 tầng, giao thức IPC 16-byte LE, mô hình sandbox đa nền tảng, Universal PCH, giới hạn tài nguyên.
- **[docs/APP_FLOW.md](docs/APP_FLOW.md)**: Sơ đồ tuần tự trực quan (Mermaid Sequence Diagrams) — Khởi động, Handshake, Chấm batch, Bài tương tác, Pre-warm, OSD watcher, Lưu/Mở `.judgedesk`, Xuất Excel `F12`, Fast Update.
- **[docs/BACKEND_SCHEMA.md](docs/BACKEND_SCHEMA.md)**: Đặc tả toàn bộ REST API Endpoints, SSE Streams, Language Profile Contracts, cấu trúc JSON `Config.cfg`, schema `.judgedesk`.
- **[docs/UI_UX_DESIGN.md](docs/UI_UX_DESIGN.md)**: Hệ thống thiết kế Design System (Tailwind CSS v4 tokens, Theme Sáng/Tối, Bảng điểm ma trận, Trung tâm Thông báo Admin, Thông báo lỗi nổi 3 thành phần, Bản đồ phím tắt `F1`-`F12`).
- **[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)**: Kế hoạch triển khai tổng thể & Lịch sử các cột mốc phát triển (`v1.0.0` đến `v1.6.1`), hiện trạng kiểm thử toàn diện.
- **[docs/admin-announcements-publishing.md](docs/admin-announcements-publishing.md)**: Quy trình soạn thảo, kiểm duyệt, ký số Ed25519 và xuất bản thông báo Admin qua GitHub Pages.
- **[docs/CONTEST-FORMAT.md](docs/CONTEST-FORMAT.md)**: Đặc tả định dạng container file `.judgedesk` (ZIP layout).
- **[docs/scratch-integration.md](docs/scratch-integration.md)**: Hướng dẫn nộp bài & đặc tả kỹ thuật chấm bài Scratch (.sb3, .sb2, .sb).
- **[INSTALL.md](INSTALL.md)**: Hướng dẫn cài đặt và xác minh tệp cài đặt cho Windows, macOS và Linux (`.deb`, `.rpm`, `.AppImage`).
- **[TOOLCHAINS.md](TOOLCHAINS.md)**: Danh mục phiên bản compiler/runtime, cờ biên dịch chuẩn, Universal PCH và cơ chế xác thực gói trên cả 3 hệ điều hành.
- **[SECURITY.md](SECURITY.md)**: Chính sách bảo mật và quy trình báo cáo lỗ hổng an toàn.
- **[SUPPORT.md](SUPPORT.md)**: Quy trình gửi phản hồi và báo lỗi kỹ thuật.
- **[CHANGELOG.md](CHANGELOG.md)**: Lịch sử thay đổi chi tiết theo từng phiên bản.
- **[BUILDING.md](BUILDING.md)**: Thiết lập môi trường và quy trình build từ mã nguồn cho Windows, macOS và Linux.
- **[RELEASING.md](RELEASING.md)**: Quy trình đóng gói, kiểm định và xuất bản release đa nền tảng.

## Môi trường phát triển

- **Node.js**: `24.19.0` (kèm npm `11.17.0`, quản lý qua `.nvmrc` hoặc Volta).
- **Rust**: `1.97.1` (khóa qua `rust-toolchain.toml`).
- **Tauri**: CLI v2 theo lockfile dự án.
- **Windows**: Visual Studio C++ Build Tools và WebView2 Runtime.
- **macOS**: Xcode Command Line Tools (`xcode-select --install`).
- **Linux (Ubuntu 22.04 LTS+)**: `build-essential`, `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`, `rpm`, `file`, `bubblewrap`, `zenity`, `xdg-utils`.

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

Đóng gói bộ cài Windows cục bộ (`.msi` Core và Full trong `release-assets-windows/`):

```powershell
npm run build:windows:release:local
```

Đóng gói bộ cài Linux `x86_64` Core và Full (`.deb`, `.rpm`, `.AppImage` kèm kiểm tra `GLIBC <= 2.34` trong `release-assets-linux/`):

```bash
JUDGEDESK_LINUX_EDITION=core bash scripts/build-linux-release.sh
JUDGEDESK_LINUX_EDITION=full bash scripts/build-linux-release.sh
bash scripts/verify-linux-deb.sh
```

Gói phát hành macOS chính thức được tạo qua pipeline CodeMagic `macos-arm64-release`.

## Cấu trúc mã nguồn

- `shared/`: Định nghĩa kiểu dữ liệu, cấu hình giao tiếp frontend/backend, chính sách HTML/trust cho thông báo (`announcements-*`) và chỉ mục nội dung toolchain.
- `src/`: Giao diện React 19, các tính năng quản lý bài thi, bảng điểm, toolbar, trung tâm thông báo (`features/announcements/`), updater, và Help Center.
- `crates/judgedesk-core/`: Backend Rust native (`Axum` HTTP/SSE, engine chấm bài, toolchain discovery & bundled full import, Universal PCH, OSD watcher, contest archive).
- `server/judge/`: Quản lý compiler, Universal PCH (`universal-pch.ts`), background pre-warm, bài tương tác (`interactor-runner.ts`), bộ phát hiện bài làm, cơ chế chấm, checker và tính điểm số hữu tỉ (Rational scoring).
- `server/toolchains/`: Quản lý tải xuống, lưu trữ, di trú chính sách thực thi (`migration.ts`), và xác thực chữ ký SHA-256/Ed25519 cho toolchains.
- `server/platform/`: Tương tác API hệ điều hành (Windows AppContainer / macOS Sandbox / Linux process supervision, Parent Watchdog).
- `native-executor/`: Module Rust thực thi mã nguồn thí sinh trong môi trường cách ly an toàn (Windows AppContainer & Job Objects / macOS Run Guardian & Seatbelt / Linux Bubblewrap + cgroup v2 + seccomp-bpf).
- `src-tauri/`: Cấu hình cửa sổ desktop Tauri v2, single-instance guard, process supervisor, dịch vụ xác thực & lưu đệm thông báo Admin (`src/announcements/`), và tiến trình backend sidecar.
