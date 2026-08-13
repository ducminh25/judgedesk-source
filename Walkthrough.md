# JudgeDesk v1.3.4 walkthrough

JudgeDesk v1.3.4 làm cho việc cập nhật Core/Full rõ ràng với người dùng không
chuyên kỹ thuật. Không thay đổi cách chuẩn bị đề, nạp bài, chấm, tính điểm, lưu
kỳ thi hay xuất Excel.

## Khi có bản cập nhật

Nút Updater vẫn tự kiểm tra phiên bản mới nhất. Khi bấm vào một update đã tìm
thấy, JudgeDesk mở hai lựa chọn:

- **Core:** bộ cài nhỏ hơn, dùng compiler trên máy hoặc toolchain tải riêng.
- **Full:** có sẵn toolchain JudgeDesk đã kiểm tra, phù hợp phòng thi/lớp học và
  máy cần chấm offline.

Edition hiện tại có nhãn **Đang dùng**. Mỗi lựa chọn cho biết dung lượng tải về
và dung lượng sau khi cài từ chính bundle của release, không dùng con số
hard-code trong giao diện.

### Cập nhật cùng edition

Chọn Core khi đang dùng Core, hoặc Full khi đang dùng Full, sẽ bắt đầu tải ngay:

- Core giữ nguyên nguồn và đường dẫn compiler/runtime người dùng đã chọn.
- Full giữ lựa chọn tùy chỉnh, đồng thời thay các file toolchain tích hợp bằng
  package có trong release mới nếu chúng thay đổi.

### Đổi edition

Chỉ khi chọn edition khác, JudgeDesk mới mở thêm cửa sổ xác nhận trước khi tải:

- **Core → Full:** cài toolchain tích hợp và ưu tiên chúng cho các ngôn ngữ được
  hỗ trợ. Đường dẫn tùy chỉnh vẫn được nhớ để có thể chọn lại.
- **Full → Core:** bỏ toolchain tích hợp khỏi thư mục ứng dụng. Toolchain đã tải
  riêng và đường dẫn tùy chỉnh không bị xóa; ngôn ngữ thiếu compiler có thể cần
  cấu hình lại.

Người dùng có thể hủy và quay lại hai lựa chọn mà chưa tải dữ liệu nào.

## Gói đã tải nhưng chưa cài

Plugin updater xác minh chữ ký rồi giữ gói tải trong bộ nhớ của tiến trình,
không tạo một bản cài tồn đọng lâu dài trong Temp. Nếu người dùng đóng JudgeDesk
trước khi bấm **Cài đặt**, JudgeDesk đóng resource tải xuống; hệ điều hành thu
hồi bộ nhớ còn lại khi tiến trình kết thúc. Lần mở sau có thể tải lại bình
thường.

## Bỏ qua phiên bản

Updater đọc `latest.json` của release mới nhất và so sánh với phiên bản đang
chạy. Vì vậy người dùng có thể bỏ qua một hay nhiều phiên bản; lần kiểm tra sau
sẽ tải thẳng Core hoặc Full của phiên bản mới nhất, không cần cài từng bản trung
gian.

## Nút ủng hộ

Nút cốc cà phê nằm giữa Updater và Công cụ. Di chuột hiển thị **Buy me a
coffee? (Ủng hộ dự án?)**. Khi bấm, JudgeDesk hỏi **Mở trang hiển thị QR?** và
chỉ mở trang QR trong trình duyệt mặc định sau khi người dùng xác nhận.

## Chuyển tiếp lên v1.3.4

v1.3.4 là mốc đầu tiên dùng manifest Core/Full mới. Do chưa có người dùng thực
tế từ v1.3.0 trở lên, không phát hành một bản migration riêng. Người dùng hiện
có sẽ cài v1.3.4 thủ công một lần; từ v1.3.4, mọi update tiếp theo sử dụng bộ
chọn edition trong app.

## Những gì không thay đổi

- Windows 10/11 x64; Windows 11 ARM dùng bản x64 qua lớp tương thích.
- macOS 11+ Apple Silicon.
- C++, C, Python, Pascal và Java cùng native secure runner hiện tại.
- Application identity, dữ liệu người dùng, updater key, toolchain signing key
  và MSI UpgradeCode.
- Windows MSI chưa có Authenticode publisher signature; macOS vẫn ad-hoc signed
  và chưa notarized, trừ khi release gate thực tế về sau xác nhận khác.
