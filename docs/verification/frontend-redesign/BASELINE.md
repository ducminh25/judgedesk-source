# Baseline inventory / screenshot manifest

Ngày: 2026-10-03. Target: bản cài JudgeDesk v1.5.1.
Registry: DisplayVersion 1.5.1. UI tools menu: v1.5.1 · 4d6c068324a3 · build local.
Executable: `C:\Program Files\JudgeDesk\themis-v2.exe`.
Ảnh tại `artifacts/FR0/`; mọi ảnh 1282 × 831 theo screenshot API, DPI chưa đo.
Locale VI. Fixture: workspace rỗng, 0 thí sinh/0 bài; toolchains đang có sẵn.
Theme lúc mở: dark. Đã chuyển light để audit rồi phục hồi dark. Không đổi locale,
toolchain configuration, contest hoặc bật OSD. Cursor glow trong ảnh có thể do
cursor/capture environment; chưa quy cho styling của app.

| Screen/state | Light | Dark | Notes |
|---|---|---|---|
| Main empty workspace | OBSERVED | OBSERVED | installed-*-vi-main-empty.png |
| Main populated/mixed verdict | NOT_OBSERVED | NOT_OBSERVED | Fixture riêng |
| Judging/progress | NOT_OBSERVED | NOT_OBSERVED | Chỉ fixture riêng |
| Toolbar menus/focus/selection | PARTIAL | PARTIAL | Tools menu observed; focus/selection chưa audit |
| Settings/preferences/OSD | PARTIAL | NOT_OBSERVED | OSD off observed; preferences ở Tools menu |
| Problem config / tests / groups | NOT_OBSERVED | NOT_OBSERVED | |
| Judging details / log / diff | NOT_OBSERVED | NOT_OBSERVED | |
| Directory picker | NOT_OBSERVED | NOT_OBSERVED | |
| Toolchain manager/prompts | PARTIAL | NOT_OBSERVED | Manager ready observed; prompts chưa; không install/uninstall |
| Contest dialogs | NOT_OBSERVED | NOT_OBSERVED | Không overwrite/delete dữ liệu thật |
| Help / changelog | NOT_OBSERVED | NOT_OBSERVED | |
| Update / confirmation dialogs | NOT_OBSERVED | NOT_OBSERVED | Không thực thi update/destructive action |

Mỗi observation ghi screenshot path, app/build, theme, locale, size, DPI nếu biết,
fixture, reproduction và findings. NOT_OBSERVED không phải PASS.

## Screenshot manifest

Build/locale/size/fixture chung như trên. Tên file tương đối với artifacts/FR0.

| File | Theme/state | Cách tái tạo / giới hạn |
|---|---|---|
| installed-dark-vi-main-empty.png | dark, empty | Mở app; chưa nạp dữ liệu |
| installed-dark-vi-tools-loading.png | dark, tools loading | Tools; đang lấy host status |
| installed-light-vi-tools-ready.png | light, tools ready | Tools → Đổi nền; ảnh chụp ngay sau toggle, toolbar còn transition; chỉ dùng identity/menu, cần chụp lại steady light tools |
| installed-light-vi-toolchains-ready.png | light, manager ready | Tools → Quản lý bộ công cụ; chờ nạp xong; phần dưới cần scroll |
| installed-light-vi-main-empty.png | light, empty | Đóng manager; toolbar đã ổn định |
| installed-light-vi-osd-off.png | light, OSD off | OSD; chờ ổn định; không bật watcher, không đổi input |
| installed-dark-vi-tools-ready.png | dark, tools ready | Phục hồi dark; chờ ổn định rồi chụp menu |

## Findings sơ bộ — chưa phải toàn bộ audit

| ID | Mức | Quan sát | Hướng xem xét |
|---|---|---|---|
| UI-001 | Medium | Toolbar trộn nhiều icon màu và nút có/không có chữ; phần lớn nút có hình thức tương tự | Chốt grouping/hierarchy và vai trò màu theo action |
| UI-002 | Medium | Toolchain manager và OSD dùng nhiều heading/label uppercase, kể cả nút đóng manager | Chuẩn hoá sentence case và typography hierarchy |
| UI-003 | Medium | Toolchain paths và hướng dẫn OSD có chữ nhỏ; paths xuống nhiều dòng trong cột hẹp | Điều chỉnh type/column allocation; bảo toàn đường dẫn đầy đủ qua cơ chế xem/copy |
| UI-004 | Low | Empty workspace chỉ có icon và thông báo giữa vùng trống lớn | Thử empty state có hướng dẫn bước kế tiếp trong scope workflow hiện có |
| UI-005 | Verification | Bản cài build 4d6c068324a3, source HEAD 8bc8ac9a... | Giữ hai baseline build riêng trước/sau, không suy ra lỗi source từ ảnh bản cài |

Contrast ratio và focus chưa đo; không ghi fail accessibility từ ảnh. Appearance
của toolbar chụp ngay sau đổi theme là transition, không kết luận theme bug.
Problem config chưa mở vì chưa nạp fixture; tiếp tục trước bất kỳ UI implementation.

## Cập nhật phiên fixture

Inventory trên là trạng thái trước fixture. Xem AUDIT.md cho coverage hiện tại,
UI-006..012 và reproduction. Tổng 33 PNG; 26 ảnh mới có metadata tại
artifacts/FR0/manifest-20261003-session2.json. App hiện light/VI thihay 15x5.
Stress đã chấm riêng A_plus_B và lưu snapshot ngoài repo. Không coi các mục
NOT_OBSERVED cũ là trạng thái mới; coverage còn thiếu được liệt kê trong AUDIT.md.
