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

## 2. Quy trình Thực thi của Máy chấm (Judge Engine)

1. **Khởi tạo môi trường Headless**:
   - Khi nhận tệp `.sb3` hoặc `.sb2`, JudgeDesk nạp cấu trúc khối lệnh vào máy ảo Scratch chạy ngầm không đồ họa.
2. **Kích hoạt Turbo Mode**:
   - Tự động chạy với tốc độ CPU tối đa (bỏ qua giới hạn 30 khung hình/giây của trình duyệt). Thời gian chạy mỗi testcase trung bình từ 10ms đến 25ms.
3. **Giám sát giới hạn thời gian (Watchdog Timer)**:
   - Áp dụng đúng Time Limit của bài toán (mặc định 1.0s hoặc theo cấu hình trong Config.cfg). Nếu hết thời gian mà chương trình chưa kết thúc, hệ thống sẽ ngắt luồng và gán kết quả TLE.
4. **Tương thích đa nền tảng**:
   - Hoạt động ổn định và cho kết quả giống hệt nhau trên cả Windows và macOS.
