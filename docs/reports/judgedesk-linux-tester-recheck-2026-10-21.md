# Kiểm tra nhanh bản Linux đã sửa

Cảm ơn bạn đã giúp test. Chỉ cần thử trên máy bạn đang dùng; không cần cài thêm distro, quay video hay chạy lại mọi ngôn ngữ.

## 1. Mở AppImage mới

Dùng **file build mới được gửi kèm**, vì file trên release v1.6.0 cũ chưa có các sửa lỗi này. Đóng JudgeDesk đang mở trước khi thử.

Mở terminal tại thư mục chứa file rồi chạy:

```bash
chmod +x ./JudgeDesk_1.6.0_amd64.AppImage
env -u LD_PRELOAD -u GDK_BACKEND -u WEBKIT_DISABLE_DMABUF_RENDERER -u WEBKIT_DISABLE_COMPOSITING_MODE ./JudgeDesk_1.6.0_amd64.AppImage 2>&1 | tee judgedesk-linux.log
```

Lệnh này chỉ bỏ các biến workaround cho **lần chạy này**, không sửa cấu hình máy. Mục đích là kiểm tra app có mở bình thường với đồ họa mặc định hay chưa.

## 2. Nếu giao diện mở bình thường

Thử một bài C++ và một bài Scratch vốn chạy đúng. Trong quản lý bộ công cụ, nếu có mục báo chưa sẵn sàng, bấm chẩn đoán cho đúng mục đó.

Chỉ cần nhắn kết quả ngắn, ví dụ:

> Ubuntu/Fedora …; AppImage mở được; C++ AC; Scratch AC.

Nếu đang dùng Fedora và muốn thử RPM, cài bằng trình quản lý gói (`sudo dnf install ./JudgeDesk-1.6.0-1.x86_64.rpm`) để hệ thống xử lý dependency. Không cần thử lại cả RPM lẫn DEB nếu bạn không tiện.

## 3. Chỉ khi vẫn có lỗi

Gửi giúp **file `judgedesk-linux.log`** và một ảnh phần báo lỗi/chẩn đoán. Có thể xem và che thông tin cá nhân hoặc đường dẫn riêng trước khi gửi. Kèm kết quả của lệnh ngắn này:

```bash
cat /etc/os-release
printf 'session=%s\nwayland=%s\ndisplay=%s\n' "$XDG_SESSION_TYPE" "$WAYLAND_DISPLAY" "$DISPLAY"
```

Nếu bạn vẫn cần một biến môi trường để mở được app, chỉ cần gửi nguyên dòng lệnh đã chạy thành công. Nếu C++ vẫn lỗi, phần cần nhất là **nguyên văn lỗi compiler** trong chẩn đoán; không cần tự tìm cách sửa hay hỏi AI khác.

AppImage này vẫn là bản Core: có runtime Scratch đi kèm, còn các compiler/runtime khác dùng bộ đã cài hoặc đã cấu hình trên máy. Bản Full chứa toàn bộ toolchain sẽ được làm riêng sau.
