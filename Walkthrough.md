# JudgeDesk v1.3.3 walkthrough

JudgeDesk v1.3.3 tập trung vào độ phản hồi và thao tác xuất Excel. Bản cập nhật
không đổi định dạng kỳ thi, dữ liệu người dùng, năm ngôn ngữ được hỗ trợ hay
cách giáo viên/học sinh phải chuẩn bị bài.

## Người dùng sẽ nhận thấy gì?

### Khởi động và chấm bài ổn định hơn

- Trên Windows, Native protection khởi động nhanh hơn khi cache toolchain lớn
  đã có đúng quyền. Nếu quyền sai hoặc không đọc được, JudgeDesk vẫn sửa hoặc
  dừng theo cơ chế fail-closed cũ; tối ưu này không nới sandbox.
- Khi bắt đầu một phiên chấm, JudgeDesk quét danh sách source, test và đọc cấu
  hình testcase đúng một lần rồi dùng lại trong phiên đó. Ứng dụng chỉ lưu sẵn
  các dữ kiện như trọng số, điểm tối đa và time limit; **không tính trước điểm
  của thí sinh**. Điểm vẫn chỉ xuất hiện sau khi chương trình chạy và checker
  trả verdict.
- Bảng điểm giảm tính toán lặp lại và gom các cập nhật tiến độ dày vào từng
  frame giao diện. Kỳ thi lớn sẽ cuộn và cập nhật mượt hơn, trong khi thứ tự
  chấm, verdict và công thức điểm giữ nguyên.
- Nén/mở file `.judgedesk`, tạo workbook Excel và một số thao tác toolchain nặng
  không còn chiếm luồng giao diện như trước. Polling chậm cũng không chạy chồng
  nhiều lượt.

### Xuất Excel dễ hiểu và khó mất dữ liệu hơn

- Nút **Xuất file Excel** sáng khi scoreboard có ít nhất một thí sinh hoặc một
  bài, kể cả chưa chấm. Các ô chưa có kết quả và tổng điểm chưa xác định được để
  trống, không tự biến thành `0`.
- Trên Windows có Microsoft Excel, JudgeDesk mở một workbook `.xlsx` mới chưa
  lưu. Khi nhấn `Ctrl+S` hoặc đóng workbook, Excel sẽ hỏi nơi lưu qua Save As,
  giảm nguy cơ người dùng đóng nhầm rồi phải xuất lại.
- Nếu Windows không có Excel, JudgeDesk giao file `.xlsx` cho hệ điều hành để
  Windows tự chọn ứng dụng. macOS cũng mở cùng file `.xlsx`; JudgeDesk không
  hiển thị `.xltx`, `.csv` hay `.ods` cho người dùng.
- Trong lúc worker đang tạo workbook, thao tác xuất trùng bị chặn. Payload có
  giới hạn tổng 256 MiB thay vì một ngưỡng nhỏ dễ cản kỳ thi lớn.

## Những gì không thay đổi

- Hỗ trợ Windows 10/11 x64 và macOS 11+ Apple Silicon. Windows ARM64 vẫn dùng
  bản x64 qua lớp tương thích của Windows 11; chưa có installer ARM64 native.
- Hỗ trợ C++, C, Python, Pascal và Java. Full vẫn là lựa chọn khuyến nghị cho
  phòng thi/lớp học; Core có thể tải managed toolchain sau.
- Core và Full dùng chung application identity, dữ liệu và cơ chế nâng cấp;
  không cài thành hai JudgeDesk song song.
- Node.js 24.19.0, npm 11.17.0, Rust 1.97.1 và Tauri v2 theo lockfile chỉ là
  toolchain dùng để build ứng dụng. Người dùng cuối không phải cài các công cụ
  này để chạy JudgeDesk.

## Phát hành và kiểm chứng

- Release chính thức: <https://github.com/ducminh25/judgedesk/releases/tag/v1.3.3>.
- Windows Core/Full được build local và kiểm tra với Defender real-time, giới
  hạn tài nguyên, single-instance, crash recovery và process cleanup.
- CodeMagic M2 build Core/Full macOS từ exact source tag, kiểm ARM64, DMG,
  ad-hoc signature, JIT entitlement, năm ngôn ngữ, custom checker, cancellation
  và process supervisor.
- Bảy asset cuối đã được tải lại ẩn danh, so byte-for-byte và kiểm
  `SHA256SUMS`. Chữ ký updater Full Windows/macOS hợp lệ với public key nhúng;
  bản sao bị sửa một byte bị từ chối.

## Giới hạn chữ ký hiện tại

- MSI chưa có Authenticode publisher signature. Chữ ký Tauri updater bảo vệ
  đường cập nhật tự động nhưng không thay thế Authenticode.
- Bản macOS dùng ad-hoc signature và chưa được Apple notarize. Người dùng nên
  kiểm `SHA256SUMS` và chỉ dùng **Open Anyway** cho file tải từ release chính
  thức.
