# Kiểm tra nhanh JudgeDesk Linux — bản QA 22/10/2026

Cảm ơn bạn đã giúp test! Chỉ cần thử trên máy đang dùng, khoảng vài phút. Không cần cài distro mới, quay video hoặc tự tìm cách sửa lỗi.

## 1. Dùng AppImage mới gửi kèm

File vẫn mang số **1.6.0**, nhưng là build QA mới; file trên release cũ chưa có các sửa lỗi. Đóng JudgeDesk đang mở trước khi thử.

Mở terminal tại thư mục chứa AppImage và chạy:

```bash
chmod +x ./JudgeDesk_1.6.0_amd64.AppImage
env -u LD_PRELOAD -u LD_LIBRARY_PATH -u GDK_BACKEND -u WEBKIT_DISABLE_DMABUF_RENDERER -u WEBKIT_DISABLE_COMPOSITING_MODE -u LIBGL_ALWAYS_SOFTWARE ./JudgeDesk_1.6.0_amd64.AppImage 2>&1 | tee judgedesk-linux.log
```

Lệnh chỉ bỏ các biến workaround trong lần mở này, để kiểm tra đồ họa mặc định; không sửa cấu hình máy.

Nếu muốn xác nhận đúng file trước khi mở, có thể dùng file checksum gửi kèm:

```bash
sha256sum --check --ignore-missing SHA256SUMS-linux
```

## 2. Thử hai bài đã biết chạy đúng

- Một bài **C++**.
- Một bài **Scratch**.

Nếu bộ công cụ báo chưa sẵn sàng, bấm **Chẩn đoán** cho đúng bộ đó. Không cần chạy lại mọi ngôn ngữ.

Nếu đang dùng **Fedora** và thuận tiện thử thêm RPM, cài bản mới bằng lệnh dưới rồi thử một bài C++; không cần chuyển sang Fedora chỉ để test:

```bash
sudo dnf install ./JudgeDesk-1.6.0-1.x86_64.rpm
```

Nếu đã cài RPM 1.6.0 cũ và `dnf` báo bản này đã có, dùng `sudo dnf reinstall ./JudgeDesk-1.6.0-1.x86_64.rpm` để thay đúng build QA mới.

## 3. Gửi kết quả ngắn

Ví dụ: **Ubuntu 26.04; AppImage mở bình thường; C++ AC; Scratch AC.** Nếu thử RPM, ghi thêm kết quả C++ của RPM.

Chỉ khi còn lỗi, gửi giúp **`judgedesk-linux.log`** và một ảnh lỗi/chẩn đoán. Nếu C++ lỗi, phần hữu ích nhất là nguyên văn thông báo compiler. Có thể che tên tài khoản, đường dẫn riêng trước khi gửi. Nếu cần biến môi trường để mở được app, gửi thêm nguyên dòng lệnh đã chạy thành công; không cần tự tìm workaround mới.

Đây vẫn là bản **Core**: Scratch có sẵn; các ngôn ngữ còn lại dùng toolchain trên máy. Ubuntu 22.04 mặc định còn cần chuẩn bị Bubblewrap/controller sandbox; không cần bạn kiểm tra hoặc cấu hình thêm trường hợp này.

Nhận dạng AppImage mới: build `qa-linux22-6dcb22a7689f56ea`, SHA-256 `97b08af0db644578b4e72c7cde9b59744e240905fb638dfd21db928cbddd3e6b`.
