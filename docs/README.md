# JudgeDesk Documentation Index

Chào mừng bạn đến với kho tài liệu chuẩn của dự án **JudgeDesk** (`ducminh25/judgedesk-source`).  
`v1.6.0` là application source baseline hiện tại (8 file phiên bản đồng bộ ở `1.6.0` cùng `crates/judgedesk-core/Cargo.toml` ở `1.6.0`), hỗ trợ đầy đủ **Windows 10/11 x64**, **macOS Apple Silicon (ARM64)** và **Linux x86_64 (`amd64` — Ubuntu 22.04 LTS, 24.04 LTS, 26.04 LTS+ qua `.deb`, `.rpm`, `.AppImage`)**. Sáu tài liệu cốt lõi bên dưới mô tả baseline sản phẩm và đã được cập nhật đồng bộ:

---

## 📚 6 Tài Liệu Cốt Lõi (Core Specifications)

| # | Tài Liệu | Tệp | Mô Tả Tóm Tắt |
| :-: | :--- | :--- | :--- |
| **1** | **PRD (Product Requirements Document)** | [`PRD.md`](./PRD.md) | Tầm nhìn sản phẩm, đối tượng người dùng (GV Tin học, HSG, Tin học trẻ), 6 ngôn ngữ hỗ trợ (C++, C, Python, Pascal, Java, Scratch), chấm offline, subtasks, bài thi tương tác (Interactive), chấm điểm phân số (Rational scoring), trần bộ nhớ 1024 MB, custom checkers đa định dạng, OSD `F8`, container `.judgedesk`, In-App Fast Updates, và các chỉ số chất lượng. |
| **2** | **TRD (Technical Requirements Document)** | [`TRD.md`](./TRD.md) | Kiến trúc 4 tầng (React 19 UI, Tauri v2 shell, Node.js SEA sidecar, Rust Native Executor), Scratch Headless VM, Universal PCH (`universal-pch.ts`), runner bài tương tác 2 chiều, giao thức IPC 16-byte LE binary, mô hình sandbox đa nền tảng, cơ chế Zero-Copy & Deduplication toolchains. |
| **3** | **UI/UX Design Document** | [`UI_UX_DESIGN.md`](./UI_UX_DESIGN.md) | Hệ thống Design System (Tailwind CSS v4 tokens, Light/Dark theme), thanh Toolbar, Scoreboard matrix với nút sắp xếp 3 trạng thái, chip cập nhật 1-click & nút ủng hộ, thông báo lỗi nổi AppErrorToast 3 thành phần (What, Why, Action), modal cấu hình subtasks/presets, và bản đồ phím tắt `F1`-`F12`. |
| **4** | **App Flow & Sequence Diagrams** | [`APP_FLOW.md`](./APP_FLOW.md) | Sơ đồ tuần tự (Mermaid Sequence Diagrams): Khởi động & Handshake, Tự động làm ấm Sandbox, Nạp Workspace, Pipeline chấm bài đa ngôn ngữ, Luồng bài tương tác 2 chiều, Universal PCH, OSD, Container `.judgedesk`, Xuất Excel `F12` theo thứ tự hiển thị, và Luồng Fast Update. |
| **5** | **Backend Schema & API Specification** | [`BACKEND_SCHEMA.md`](./BACKEND_SCHEMA.md) | Đặc tả toàn bộ REST Endpoints, NDJSON & SSE Event Streams, Language Profile Contracts (kèm `scratch-turbowarp-v1`), cấu trúc JSON `Config.cfg` (`polygonConfig`, `compile: { schemaVersion: 1, profile, flags }`, interactive & 1024MB memory), schema `manifest.json`, schema receipt `.judgedesk-package.json`, và mã lỗi chuẩn. |
| **6** | **Master Implementation Plan** | [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) | Tổng kết chi tiết 12 cột mốc triển khai (`v1.0.0` $\rightarrow$ `v1.5.5`), hiện trạng kiểm thử toàn diện và các tiêu chuẩn kỹ thuật phát hành. |

---

## 🛠️ Tài Liệu Kỹ Thuật Bổ Trợ Khác
* [`pure-rust-core-start-here.md`](./pure-rust-core-start-here.md): Điểm bắt đầu ngắn gọn cho người dùng, Antigravity và Codex; quy tắc conversation, ownership và verification.
* [`verification/pure-rust-core/STATUS.md`](./verification/pure-rust-core/STATUS.md): Nguồn sự thật hiện tại về package nào READY/đang làm/đang review/DONE/có thể skip.
* [`verification/pure-rust-core/WORKLOG.md`](./verification/pure-rust-core/WORKLOG.md): Nhật ký append-only về claim, handoff, test evidence, blocker và quyết định review.
* [`pure-rust-core-detailed-implementation-plan.md`](./pure-rust-core-detailed-implementation-plan.md): Kế hoạch triển khai và kiểm thử chi tiết cho target `v1.6.0`.
* [`pure-rust-core-next-steps-audit.md`](./pure-rust-core-next-steps-audit.md): Đối chiếu hiện trạng `v1.5.5` + working-tree `Bước 1–5`, ánh xạ `WP*` DAG, khoảng trống còn lại và lưu trữ snapshot `v1.5.0` (2026-09-19).
* [`reports/pure-rust-core-progress-2026-10-14.md`](./reports/pure-rust-core-progress-2026-10-14.md): Báo cáo tiến độ và bằng chứng thực thi trong working tree cho Giai đoạn A (`Bước 1–5`) trên Windows x64 và macOS arm64.
* [`pure-rust-core-antigravity-handoff.md`](./pure-rust-core-antigravity-handoff.md): Hướng dẫn trung lập về package handoff, quyền sở hữu và điều kiện dừng/review.
* [`osd-themis-compatibility.md`](./osd-themis-compatibility.md): Đặc tả tương thích OSD Themis Web (`0[user][problem]ext`, kiểm tra ổn định file, `$History`, `logs/<raw-filename>.log`).
* [`guidelines.md`](../guidelines.md): Bộ quy chuẩn kỹ thuật toàn diện cho lập trình viên & AI Agents (Bắt buộc đọc).
* [`CONTEST-FORMAT.md`](./CONTEST-FORMAT.md): Đặc tả định dạng container file `.judgedesk` (ZIP layout).
* [`scratch-integration.md`](./scratch-integration.md): Hướng dẫn nộp bài & đặc tả kỹ thuật chấm bài Scratch (.sb3, .sb2, .sb).
* [`TOOLCHAINS.md`](../TOOLCHAINS.md): Hướng dẫn quản lý compiler, runtime, Universal PCH và cờ biên dịch chuẩn.
* [`BUILDING.md`](../BUILDING.md): Hướng dẫn build và đóng gói installer.
* [`RELEASING.md`](../RELEASING.md): Quy trình đóng gói và xuất bản release.
* [`WINDOWS_TEST_CHECKLIST.md`](./WINDOWS_TEST_CHECKLIST.md): Danh mục kiểm thử hệ thống cục bộ trên Windows.
