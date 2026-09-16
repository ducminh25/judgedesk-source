# Hướng dẫn & Đặc tả Kỹ thuật Chấm bài Scratch trong JudgeDesk

Tài liệu này mô tả chi tiết quy chuẩn nộp bài, cơ chế xử lý Input/Output (I/O) và cách thực thi tệp dự án Scratch (.sb3, .sb2, .sb) trong JudgeDesk.

---

## 1. Hướng dẫn Thí sinh Làm bài & Nộp bài (Writing Solutions)

### A. Quy cách đặt tên tệp bài làm
- Thí sinh lập trình trên phần mềm Scratch Desktop hoặc trên trình duyệt web (Scratch Web).
- Khi hoàn thành, lưu tệp về máy tính (vào menu *Tệp -> Lưu về máy tính*).
- Đặt tên tệp bài làm trùng với mã bài của đề thi, ví dụ:
  - `BAI1.sb3` hoặc `BAI1.sb2`
  - `SUM.sb3`
  - `PRIME.sb3`
- Đặt tệp `.sb3` trực tiếp vào thư mục mang tên thí sinh (ví dụ thư mục `NguyenVanA/BAI1.sb3`).

### B. Cơ chế Nhập dữ liệu (Standard Input)
- Sử dụng khối lệnh:
  ```scratch
  Hỏi [Nhập N] và đợi
  (ask [prompt] and wait)
  ```
- **Lưu ý quan trọng**:
  - Dòng chữ hiển thị câu hỏi (ví dụ "Nhập a = ", "N = ?") chỉ là nhãn giao diện cho người xem, máy chấm sẽ tự động bỏ qua dòng chữ này.
  - Giá trị tiếp theo trong bộ test (.INP) sẽ được tự động đưa vào biến `câu trả lời` (`answer`).
  - Học sinh có thể dùng nhiều khối Hỏi liên tiếp để nhận lần lượt các số trong đề bài.

### C. Cơ chế Xuất dữ liệu (Standard Output)
- Học sinh xuất kết quả bài toán bằng khối lệnh:
  - **Khối `Nói [kết quả]` (`say [value]`)**: In kết quả ra màn hình có kèm ký tự xuống dòng.
  - **Khối `Nghĩ [kết quả]` (`think [value]`)**: In kết quả liên tiếp không kèm ký tự xuống dòng.
- Chỉ in đúng kết quả theo yêu cầu của đề bài (ví dụ: `Nói (dien_tich)`), tránh ghép thêm các từ thừa như "Ket qua la: " trừ khi đề bài yêu cầu cụ thể.

### D. Những điều cần tránh
- Không cần thiết kế chuyển động nhân vật, đổi trang phục hay thêm âm thanh vì máy chấm chạy ngầm ở chế độ tăng tốc (Turbo).
- Tránh dùng khối `liên tục` (`forever`) nếu không có điều kiện dừng hoặc thiếu khối `dừng lại [tất cả]` (`stop all`), vì chương trình sẽ bị tính lỗi Quá thời gian (Time Limit Exceeded - TLE).

---

## 2. Quy trình Thực thi của Máy chấm (Judge Engine & Sandbox Architecture)

1. **Khởi tạo môi trường Headless**:
   - Khi nhận tệp `.sb3`, `.sb2` hoặc `.sb`, JudgeDesk nạp mã nguồn JSON và assets vào máy ảo Headless VM `scratch-run` (nhân TurboWarp / VNOI execution engine đóng gói sẵn).
   - Máy ảo chạy thuần CPU không cần GPU/màn hình ảo, nạp sẵn kịch bản và ánh xạ các khối `ask and wait` vào `stdin` và `say`/`think` vào `stdout`.

2. **Kích hoạt Turbo Mode & Siêu Tối Ưu**:
   - Tự động chạy với tốc độ xung nhịp CPU tối đa (bỏ qua giới hạn 30/60 FPS thông thường của trình duyệt).
   - Thời gian thực thi mỗi testcase thông thường chỉ từ 10ms đến 25ms.

3. **Cách ly Sandbox Đa Nền Tảng**:
   - **Windows x64**: Thực thi trong tiến trình bảo vệ bởi Windows Job Object ở chế độ `ResourceOnly` (áp dụng hạn ngạch CPU, trần RAM, và tự động thu hồi toàn bộ cây tiến trình con). Việc sử dụng `ResourceOnly` cho runtime Scratch đảm bảo runtime Node/V8 không bị xung đột cấp phát bộ nhớ ảo với Win32 AppContainer (`STATUS_DLL_INIT_FAILED`).
   - **macOS Apple Silicon**: Thực thi dưới sandbox **Seatbelt** (`sandbox-exec -f seatbelt.sb`), chặn hoàn toàn truy cập mạng, chặn ghi đè hệ thống, chỉ cấp quyền đọc tệp `.sb3` và ghi tệp output tạm thời.

4. **Quản lý Tài nguyên & Giới hạn Bộ nhớ (Resource Limits)**:
   - **Time Limit**: Giám sát bởi phần cứng và Native Watchdog Timer (mặc định 1.0s hoặc theo `Config.cfg`). Khi chạm ngưỡng thời gian, cây tiến trình bị tiêu diệt ngay lập tức (Tree Kill) và gán kết quả `TLE`.
   - **Memory Limit**: Hỗ trợ dải cấu hình từ **8 MB đến 1024 MB** (mặc định 256 MB), ngắt ngay lập tức khi vượt quá dung lượng và gán kết quả `MLE`.

5. **Thu dọn tài nguyên an toàn (Process Teardown)**:
   - Toàn bộ các luồng worker và file bộ nhớ đệm tạm thời trong `%TEMP%` đều được gắn UUID và dọn sạch ngay sau khi mỗi testcase hoàn tất, ngăn chặn hoàn toàn hiện tượng rò rỉ bộ nhớ hoặc zombie process.
