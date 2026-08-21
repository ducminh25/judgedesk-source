JudgeDesk v1.3.7 mang đến luồng Cập nhật Siêu tốc (In-App Fast Core Updates ~39 MB), cơ chế Early Toolchain Migration vĩnh viễn (tự động chuyển và bảo lưu 100% compiler sang AppData an toàn), chế độ Chấm trực tuyến OSD (F8), Trung tâm trợ giúp ngoại tuyến (F1), và hệ thống thông báo lỗi 3 thành phần thân thiện.

## Có gì mới trong v1.3.7

### 1. Luồng Cập Nhật Siêu Tốc (Fast In-App Core Updates)
- **Tải và cài đặt trong vài giây**: Mọi bản cập nhật tự động trong ứng dụng mặc định tải gói **Core Update (~39 MB)**, hoàn tất tải trong **3–5 giây** và cài đặt trong **2 giây**, không còn phải tải lại hơn 800 MB toolchains không thay đổi.
- **Cơ chế Early Migration Vĩnh Viễn (Cut & Paste)**: Tự động phát hiện và di chuyển toàn bộ compiler cũ từ `Program Files\JudgeDesk\toolchains\` sang `%LOCALAPPDATA%\ThemisV2\toolchains\`, bảo lưu nguyên vẹn file receipt `.judgedesk-package.json`, và xóa sạch thư mục cũ để giải phóng ngay **~800 MB ổ đĩa**.
- **Tự động chứng thực 100% "Xanh / Ready" trên bản Core**: Toàn bộ compiler đã migrate được nhận diện là Official Managed Package, sẵn sàng chấm ngay trong Native Sandbox mà không hiện cảnh báo bảo mật.
- **Duy trì ĐỦ 2 bản Core & Full trên GitHub Releases**: Người dùng tải mới hoặc thầy/cô cài đặt phòng thi offline qua USB vẫn luôn có sẵn bản **Full All-in-One (~813 MB)** và bản **Core (~39 MB)**.

### 2. Chế độ Chấm Trực Tuyến OSD (F8)
- **Folder Watcher thời gian thực**: Lắng nghe thư mục nộp bài qua mạng LAN/Share (debounce 500ms), tự động xếp hàng đợi FIFO, nạp thí sinh và chấm bài tự động.
- **Live Scoreboard SSE**: Trả kết quả chấm trực tiếp lên bảng điểm theo thời gian thực.
- **Bảng điều khiển OSD (`F8`)**: Cung cấp giao diện bật/tắt, chọn thư mục nộp bài, và hiển thị trạng thái hàng đợi trực quan.

### 3. Thông Báo Lỗi 3 Thành Phần & Bảo Mật Đường Dẫn Cá Nhân
- **Chuẩn hóa thông báo lỗi thân thiện**: Hiển thị Toast/Banner nổi với 3 nội dung rõ ràng: **Chuyện gì xảy ra (What)**, **Nguyên nhân (Why)**, và **Hướng xử lý nhanh (Action)** kèm nút bấm CTA.
- **Khử trùng bảo mật PII**: Tự động lọc sạch toàn bộ đường dẫn máy tính cá nhân (`C:\Users\username\...`) và stack traces kỹ thuật khỏi giao diện người dùng.
- **Loại bỏ triệt để Silent Errors**: Bắt và thông báo rõ ràng toàn bộ các lỗi tiềm ẩn khi nạp bài, mở thư mục hoặc xuất Excel.

### 4. Trung Tâm Trợ Giúp Ngoại Tuyến (F1)
- Tra cứu tài liệu hướng dẫn, bảng phím tắt `F1`-`F12`, và công cụ sao chép thông số chẩn đoán hệ thống an toàn.

---

## Chọn bản nào?

- **Full (khuyến nghị cho cài đặt phòng thi/lớp học qua USB)**: Có sẵn đầy đủ các bộ công cụ biên dịch (C/C++, Python, Pascal, Java) đã kiểm thử nghiêm ngặt; hoạt động hoàn toàn offline mà không cần kết nối mạng.
- **Core (khuyến nghị cho cá nhân & cập nhật)**: Bộ cài gọn nhẹ (~39 MB); tải siêu nhanh trong vài giây và tự động nhận diện/sử dụng toàn bộ compiler đã có trên máy.

---

## Nền tảng hỗ trợ

- **Windows**: Windows 10/11 x64.
- **macOS**: macOS 11 trở lên trên Apple Silicon (M1/M2/M3/M4...).
