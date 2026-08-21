JudgeDesk v1.3.8 bổ sung cửa sổ giới thiệu tính năng mới (What's New / Changelog) tự động kích hoạt sau cập nhật, sửa triệt để lỗi xuất Excel bảng điểm và metadata, hỗ trợ mở file `.judgedesk` trực tiếp khi bấm đúp từ File Explorer/Finder, và nâng cấp trải nghiệm kéo thả thư mục/file kỳ thi.

## Có gì mới trong v1.3.8

### 1. Trải nghiệm Cập nhật & Thông tin Phát hành
- **Tự động hiển thị "Có gì mới trong JudgeDesk"**: Ngay sau khi nâng cấp lên phiên bản mới, ứng dụng tự động hiển thị cửa sổ giới thiệu các cải tiến và tính năng mới một lần duy nhất; tự động ghi nhớ để không làm phiền ở các lần mở tiếp theo.
- **Tra cứu Nhật ký thay đổi (Changelog)**: Bổ sung mục tra cứu toàn bộ lịch sử phát hành song ngữ (Tiếng Việt & Tiếng Anh) trực tiếp từ **Trung tâm Trợ giúp (`F1`)** kèm liên kết tới GitHub Release Notes.

### 2. Sửa lỗi Xuất Excel & Bảng điểm
- **Sửa lỗi bảng điểm rỗng & Metadata Unavailable**: Sửa triệt để hiện tượng xuất file Excel bảng điểm trống và thông báo "Run Metadata: Unavailable" khi xuất từ kỳ thi đã lưu hoặc sau khi chấm bài trực tuyến OSD.
- **So khớp không phân biệt hoa thường (Case-Insensitive)**: Tự động so khớp tên thí sinh và bài thi linh hoạt giữa các tầng dữ liệu mà vẫn bảo toàn chính xác định dạng hiển thị ban đầu.
- **Tự động tổng hợp Metadata môi trường**: Tự động lấy dữ liệu môi trường thực tế (`hostStatus`) làm fallback khi chưa có metadata trực tiếp từ lượt chấm.

### 3. Mở Kỳ thi `.judgedesk` & Kéo Thả Trực Quan
- **Mở file trực tiếp khi Bấm đúp**: Đăng ký liên kết định dạng `.judgedesk` trên Windows và macOS. Bấm đúp file kỳ thi sẽ mở ứng dụng (hoặc focus vào cửa sổ đang chạy) và tự động nạp toàn bộ đề bài, thí sinh, cấu hình cùng bảng điểm.
- **Kéo thả File & Thư mục Trực quan**: Thêm hiệu ứng overlay toàn màn hình khi kéo thả file `.judgedesk` vào ứng dụng, đồng thời nâng cấp hiệu ứng phát sáng vùng thả thư mục trong hộp thoại chọn Đề thi / Thí sinh.

---

## Chọn bản nào?

- **Full (khuyến nghị cho cài đặt phòng thi/lớp học qua USB)**: Có sẵn đầy đủ các bộ công cụ biên dịch (C/C++, Python, Pascal, Java) đã kiểm thử nghiêm ngặt; hoạt động hoàn toàn offline mà không cần kết nối mạng.
- **Core (khuyến nghị cho cá nhân & cập nhật)**: Bộ cài gọn nhẹ (~39 MB); tải siêu nhanh trong vài giây và tự động nhận diện/sử dụng toàn bộ compiler đã có trên máy.

---

## Nền tảng hỗ trợ

- **Windows**: Windows 10/11 x64.
- **macOS**: macOS 11 trở lên trên Apple Silicon (M1/M2/M3/M4...).
