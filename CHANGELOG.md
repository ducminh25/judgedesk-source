# Changelog

Tất cả thay đổi đáng chú ý của JudgeDesk được ghi tại đây. Dự án dùng Semantic
Versioning; các bản `1.x` giữ tương thích updater và dữ liệu ứng dụng hiện có.

## [1.2.0] - 2026-07-19

### Nổi bật

- Đổi tên sản phẩm và thiết kế lại giao diện thành **JudgeDesk**, theo hướng
  desktop workbench gọn hơn trên Windows và macOS.
- Thêm file kỳ thi `.judgedesk`: lưu problems, source thí sinh, cấu hình, lựa
  chọn và toàn bộ kết quả chấm trong một file ZIP portable duy nhất.
- Scoreboard mới tự fit theo cửa sổ lớn, giữ kích thước điều khiển khi cửa sổ
  hẹp, không chọn text trong cell, không hiện dấu ba chấm và hỗ trợ menu chuột
  phải/secondary click cùng nút menu dọc.

### Thêm mới

- Toolbar rút gọn với New/Open/Save contest, Load problems, Load contestants,
  Reload, Judge, Export Excel, Delete selected scores và Update.
- Menu theo cell, problem và contestant cho cấu hình, xóa điểm, chấm lại và xem
  chi tiết; thao tác xóa luôn có bước xác nhận.
- Progress khi lưu contest và cảnh báo Save / Don't save / Cancel khi New,
  Open hoặc đóng app với dữ liệu chưa lưu.
- Chi tiết chấm hiển thị đúng `score / max score` và số test AC hoàn toàn.

### An toàn và tính đúng đắn

- Checker tích hợp và `testlib.h` không còn được cài dưới dạng source có thể sửa.
  App nhúng bản canonical vào binary và tạo một thư mục preview tạm mới mỗi lần
  người dùng chọn View source; bản preview luôn kèm `testlib.h`.
- Bản checker dùng để compile được khôi phục từ dữ liệu nhúng, hoàn toàn tách
  khỏi file preview mà người dùng có thể chỉnh sửa.
- Khóa các thao tác thay đổi contest, cấu hình, điểm và export trong lúc batch
  grading hoặc save contest đang chạy để tránh xung đột trạng thái.
- Bỏ Global time limit; mỗi test dùng time limit trong cấu hình problem/Polygon,
  mặc định 1 giây khi không có cấu hình.
- Sửa tổng điểm Polygon, score tối đa và thống kê test pass trong cửa sổ chi tiết.

### Sửa lỗi

- Sửa đóng app bằng nút X trên Windows và nút đóng cửa sổ trên macOS, bao gồm
  contest trắng, Don't save và sau khi tạo New Contest.
- Ngăn sidecar debug cũ gây lỗi `Access is denied` khó hiểu khi chạy lại app.
- Cải thiện tốc độ tải trạng thái hệ thống ban đầu và vòng đời sidecar.
- Giới hạn tên checker/cột dài để không kéo layout vượt khỏi cửa sổ.

### Nâng cấp

- Giữ nguyên identifier `com.themisv2.judge`, public updater key và endpoint.
  Máy đang chạy `1.1.3` hoặc `1.1.4` có thể cập nhật trực tiếp lên `1.2.0`.
- Giữ nguyên Windows MSI UpgradeCode của ThemisV2 để JudgeDesk thay thế bản cũ
  thay vì cài song song.
- macOS hỗ trợ Apple Silicon, macOS 11 trở lên. Windows hỗ trợ Windows 10/11 x64.

[1.2.0]: https://github.com/ducminh25/themis-v2/releases/tag/v1.2.0
