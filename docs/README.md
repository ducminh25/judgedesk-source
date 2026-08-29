# JudgeDesk Documentation Index

Chào mừng bạn đến với kho tài liệu chuẩn của dự án **JudgeDesk** (Private Source).  
Hệ thống tài liệu bao gồm đầy đủ 6 bộ tài liệu chuẩn (Core Specifications) được khảo sát, chuẩn hóa và đồng bộ 100% với phiên bản hiện tại (`v1.4.43` / `v1.4.x`):

---

## 📚 6 Tài Liệu Cốt Lõi (Core Specifications)

| # | Tài Liệu | Tệp | Mô Tả Tóm Tắt |
| :-: | :--- | :--- | :--- |
| **1** | **PRD (Product Requirements Document)** | [`PRD.md`](./PRD.md) | Tầm nhìn sản phẩm, đối tượng người dùng (GV Tin học, HSG, Tin học trẻ), 6 ngôn ngữ hỗ trợ (C++, C, Python, Pascal, Java, Scratch), chấm offline, subtasks, custom checkers đa định dạng, OSD `F8`, container `.judgedesk`, In-App Fast Updates, và các chỉ số chất lượng. |
| **2** | **TRD (Technical Requirements Document)** | [`TRD.md`](./TRD.md) | Kiến trúc 4 tầng (React 19 UI, Tauri v2 shell, Node.js SEA sidecar, Rust Native Executor), Scratch Headless VM, giao thức IPC 16-byte LE binary, mô hình sandbox đa nền tảng, cơ chế Zero-Copy & Deduplication toolchains. |
| **3** | **UI/UX Design Document** | [`UI_UX_DESIGN.md`](./UI_UX_DESIGN.md) | Hệ thống Design System (Tailwind CSS v4 tokens, Light/Dark theme), thanh Toolbar, Scoreboard matrix với nút sắp xếp 3 trạng thái, thông báo lỗi nổi AppErrorToast 3 thành phần (What, Why, Action), modal cấu hình subtasks/presets, và bản đồ phím tắt `F1`-`F12`. |
| **4** | **App Flow & Sequence Diagrams** | [`APP_FLOW.md`](./APP_FLOW.md) | Sơ đồ tuần tự (Mermaid Sequence Diagrams): Khởi động & Handshake, Tự động làm ấm Sandbox, Nạp Workspace, Pipeline chấm bài đa ngôn ngữ & Scratch, OSD, Container `.judgedesk`, Xuất Excel `F12` theo thứ tự hiển thị, và Luồng Fast Update. |
| **5** | **Backend Schema & API Specification** | [`BACKEND_SCHEMA.md`](./BACKEND_SCHEMA.md) | Đặc tả toàn bộ REST Endpoints, SSE Event Streams, Language Profile Contracts (kèm `scratch-turbowarp-v1`), cấu trúc JSON `Config.cfg`, schema `manifest.json`, schema receipt `.judgedesk-package.json`, và mã lỗi chuẩn. |
| **6** | **Master Implementation Plan** | [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) | Tổng kết chi tiết 7 cột mốc triển khai (v1.0.0 $\rightarrow$ v1.4.43), hiện trạng kiểm thử toàn diện (>470 tests, 466 pass, 0 fail), và các tiêu chuẩn kỹ thuật phát hành. |

---

## 🛠️ Tài Liệu Kỹ Thuật Bổ Trợ Khác
* [`guidelines.md`](../guidelines.md): Bộ quy chuẩn kỹ thuật toàn diện cho lập trình viên & AI Agents.
* [`CONTEST-FORMAT.md`](./CONTEST-FORMAT.md): Đặc tả định dạng container file `.judgedesk` (ZIP layout).
* [`scratch-integration.md`](./scratch-integration.md): Hướng dẫn nộp bài & đặc tả kỹ thuật chấm bài Scratch (.sb3, .sb2, .sb).
* [`TOOLCHAINS.md`](../TOOLCHAINS.md): Hướng dẫn quản lý compiler, runtime và cờ biên dịch chuẩn.
* [`BUILDING.md`](../BUILDING.md): Hướng dẫn build và đóng gói installer.
* [`RELEASING.md`](../RELEASING.md): Quy trình đóng gói và xuất bản release.
* [`WINDOWS_TEST_CHECKLIST.md`](./WINDOWS_TEST_CHECKLIST.md): Danh mục kiểm thử hệ thống cục bộ trên Windows.

