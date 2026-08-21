# JudgeDesk Documentation Index

Chào mừng bạn đến với kho tài liệu chuẩn của dự án **JudgeDesk** (Private Source).  
Hệ thống tài liệu bao gồm đầy đủ 6 bộ tài liệu chuẩn (Core Specifications) được khảo sát, chuẩn hóa và đồng bộ 100% với phiên bản hiện tại (`v1.3.7+`):

---

## 📚 6 Tài Liệu Cốt Lõi (Core Specifications)

| # | Tài Liệu | Tệp | Mô Tả Tóm Tắt |
| :-: | :--- | :--- | :--- |
| **1** | **PRD (Product Requirements Document)** | [`PRD.md`](./PRD.md) | Tầm nhìn sản phẩm, đối tượng người dùng (GV Tin học, HSG), các tính năng chính (chấm offline, subtasks, custom checkers, OSD `F8`, container `.judgedesk`, In-App Fast Updates), và các chỉ số phi chức năng. |
| **2** | **TRD (Technical Requirements Document)** | [`TRD.md`](./TRD.md) | Kiến trúc 4 tầng (React 19 UI, Tauri v2 shell, Node.js SEA sidecar, Rust Native Executor), giao thức IPC 16-byte LE binary, mô hình sandbox, kiến trúc Decoupled Toolchains & Early Migration. |
| **3** | **UI/UX Design Document** | [`UI_UX_DESIGN.md`](./UI_UX_DESIGN.md) | Hệ thống Design System (Tailwind CSS v4 tokens, Light/Dark theme), cấu trúc AppToolbar, Scoreboard matrix, thông báo lỗi 3 thành phần (What, Why, Action), modal cập nhật nhanh 1-click, và bản đồ phím tắt `F1`-`F12`. |
| **4** | **App Flow & Sequence Diagrams** | [`APP_FLOW.md`](./APP_FLOW.md) | Sơ đồ tuần tự (Mermaid Sequence Diagrams): Khởi động & Handshake, Early Migration, Nạp Workspace, Pipeline chấm bài chi tiết, OSD, Container `.judgedesk`, Xuất Excel `F12`, và Luồng Fast Update. |
| **5** | **Backend Schema & API Specification** | [`BACKEND_SCHEMA.md`](./BACKEND_SCHEMA.md) | Đặc tả toàn bộ REST Endpoints, SSE Event Streams, cấu trúc JSON `Config.cfg`, schema `manifest.json`, schema receipt `.judgedesk-package.json`, và mã lỗi chuẩn. |
| **6** | **Master Implementation Plan** | [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) | Tổng kết chi tiết 5 cột mốc triển khai (v1.0.0 $\rightarrow$ v1.3.7), hiện trạng kiểm thử (>445 tests), và các tiêu chuẩn kỹ thuật phát hành. |

---

## 🛠️ Tài Liệu Kỹ Thuật Bổ Trợ Khác
* [`guidelines.md`](../guidelines.md): Bộ quy chuẩn kỹ thuật toàn diện cho lập trình viên & AI Agents.
* [`CONTEST-FORMAT.md`](./CONTEST-FORMAT.md): Đặc tả định dạng container file `.judgedesk` (ZIP layout).
* [`TOOLCHAINS.md`](../TOOLCHAINS.md): Hướng dẫn quản lý compiler và runtime.
* [`BUILDING.md`](../BUILDING.md): Hướng dẫn build và đóng gói installer.
