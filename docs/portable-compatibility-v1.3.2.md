# JudgeDesk v1.3.2 — audit khả năng portable

Ngày audit: 2026-08-02
Phạm vi phát hành: **chỉ bộ cài Windows và disk image macOS**. Không tạo hoặc
phát hành ZIP/SFX portable trong v1.3.2.

## Kết luận

Kiến trúc hiện tại đã khá gần một bản **install-free**: giao diện Tauri, hai
sidecar và resource/toolchain Full đều được định vị tương đối qua resource
directory của bundle, còn dữ liệu có quyền ghi nằm trong thư mục ứng dụng của
người dùng. Tuy nhiên, chỉ ZIP thư mục đã cài rồi gọi đó là portable sẽ tạo một
artefact chưa được hỗ trợ.

JudgeDesk hiện **chưa tương thích true-portable** (data/log/config đi cùng app)
và chưa có contract `portable.flag`. Không nên dùng SFX kiểu cũ của Themis cho
release hiện đại; phương án tương lai phù hợp hơn là ZIP đã ký/kiểm chứng.

## Những phần đã tương thích với install-free

- Backend SEA và native executor là sidecar đóng gói, không cần Node/Rust được
  cài trên máy đích (`bundle.externalBin`).
- Tauri truyền `resource_dir` chính xác cho backend qua `THEMIS_RESOURCE_DIR`;
  backend lấy manifest, compiler compatibility header và toolchain Full từ
  resource root, không phụ thuộc thư mục làm việc hiện tại.
- Full đặt các package tích hợp trong resource tree chỉ đọc. Core và Full cùng
  format distribution document nên cùng một pipeline có thể tạo nội dung ZIP.
- Workspace chấm và cache executor không ghi vào thư mục chứa app.
- Single-instance lock dùng local application-data theo identifier, vì vậy app
  vẫn có thể khởi động từ thư mục chỉ đọc hoặc thư mục người dùng.

## Blocker phải giải quyết trước một release portable

### Windows

1. Full MSI đang mang **WebView2 offline installer** như một hành vi của WiX;
   runtime này không tự đi theo khi chỉ ZIP thư mục app. Portable tương lai phải
   chọn rõ một trong hai contract:
   - yêu cầu Evergreen WebView2 đã có trên Windows; hoặc
   - đóng gói fixed-version WebView2 và cấu hình Tauri dùng đúng runtime đó.
2. Updater hiện chọn và cài **Full MSI**. Một executable chạy từ ZIP không được
   phép gọi luồng cập nhật installer như thể đang được WiX quản lý. Portable
   phải tắt updater hoặc có cơ chế thay trọn thư mục riêng, có drain tiến trình,
   xác minh chữ ký và rollback.
3. Cần test thực trên Windows 10/11 sạch, tài khoản không admin, Defender bật,
   đường dẫn có khoảng trắng/Unicode, ổ USB/ổ mạng và thư mục chỉ đọc.
4. Strict AppContainer cho local toolchain phụ thuộc ACL của vị trí cài đặt;
   bản portable không được tự sửa ACL recursive trên thư mục app hoặc toolchain
   người dùng. Gói Full đi cùng app vẫn phải giữ quyền read/execute phù hợp.

### macOS

1. Chỉ phân phối nguyên `.app` trong ZIP bằng công cụ giữ executable bits,
   symlink và bundle structure. Không ZIP riêng các file bên trong bundle.
2. Chữ ký/notarization/Gatekeeper phải được xác minh sau download và extract.
   Cấu hình local hiện ad-hoc (`signingIdentity: "-"`) không phải bằng chứng
   cho một artefact portable phát hành công khai.
3. Updater `.app.tar.gz` hiện là artefact Full dành cho app đã cài. Cần quyết
   định rõ portable update/replace và test khi chạy từ Downloads, Desktop,
   volume ngoài, đường dẫn có khoảng trắng/Unicode.
4. Full trên macOS vẫn cần Apple Clang và macOS SDK từ Xcode Command Line Tools
   (hoặc Xcode) để chấm C/C++; chỉ Python, FPC và Temurin là managed package đi
   kèm. Một bản portable tương lai không được mô tả là self-contained cho C/C++
   nếu chưa đóng gói và cấp phép một toolchain riêng.

### True-portable trên cả hai hệ điều hành

1. Node backend lưu preferences, discovery snapshot, toolchain tải về và policy
   trong `%LOCALAPPDATA%\\ThemisV2` hoặc `~/Library/Application Support/ThemisV2`.
2. Tauri lưu backend log và single-instance/process-tree lock trong data/log
   directory của hệ điều hành. Chỉ đổi `THEMIS_APP_DATA_DIR` ở backend là chưa
   đủ; Rust shell và backend phải dùng cùng một portable root canonical.
3. Cần `portable.flag`/manifest có schema, xác định một thư mục data cạnh app,
   kiểm tra thư mục đó có quyền ghi và fail rõ ràng thay vì fallback âm thầm.
4. USB tháo đột ngột, nhiều bản app dùng chung data, update rollback, quyền file,
   dung lượng toolchain/cache và bảo vệ contest chưa công bố đều cần threat
   model riêng.

## Prototype nội bộ đề xuất cho phiên bản sau

1. Thêm build target `portable-smoke` nhưng không upload release asset.
2. Windows tạo ZIP từ app/resources/sidecars Full hoặc Core, updater bị vô hiệu;
   chạy smoke trên máy sạch với Evergreen WebView2 trước, sau đó đánh giá fixed
   runtime nếu cần.
3. macOS tạo ZIP nguyên `.app`, verify architecture/signature trước và sau
   extract, rồi chạy smoke trên Apple Silicon.
4. Gate tối thiểu: mở app, single-instance, nhận đúng edition, thấy built-in
   Full, compile/run năm ngôn ngữ, Save/Open contest, restart, đường dẫn
   Unicode/space, không admin, offline và cleanup toàn bộ process tree.
5. Chỉ sau khi install-free ổn định mới thiết kế true-portable data semantics.

## Quyết định v1.3.2

- Không thêm target bundle portable vào release pipeline.
- Không thêm SFX executable.
- Help chỉ mô tả đây là khả năng tương lai và hướng người dùng tới installer/DMG
  chính thức.
- Các thay đổi toolchain/resource của v1.3.2 phải tiếp tục dùng resource root
  do Tauri truyền, không thêm đường dẫn tuyệt đối gắn với vị trí cài đặt.
