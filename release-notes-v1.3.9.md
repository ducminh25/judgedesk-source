JudgeDesk v1.3.9 là bản cập nhật hotfix sửa dứt điểm lỗi xuất file Excel bảng điểm trống do lọc selection và đảm bảo thông số Run Metadata luôn được ghi nhận hoàn chỉnh trong mọi tình huống.

## Có gì mới trong v1.3.9

### Sửa triệt để Xuất Excel & Tối ưu Bảng điểm
- **Sửa lỗi bảng điểm rỗng khi xuất Excel**: Nâng cấp bộ phân giải selection linh hoạt (không phân biệt hoa thường và khoảng trắng) kết hợp cơ chế fallback thông minh; đảm bảo xuất đầy đủ 100% các cột bài tập, điểm số từng bài, tổng điểm và bảng chi tiết testcase.
- **Bảo đảm Run Metadata môi trường**: Luôn tổng hợp và ghi nhận đầy đủ thông số môi trường hệ thống trong file Excel kể cả khi xuất từ kỳ thi đã lưu hoặc khi chưa có snapshot trực tiếp từ compiler.

---

## Chọn bản nào?

- **Full (khuyến nghị cho cài đặt phòng thi/lớp học qua USB)**: Có sẵn đầy đủ các bộ công cụ biên dịch (C/C++, Python, Pascal, Java) đã kiểm thử nghiêm ngặt; hoạt động hoàn toàn offline mà không cần kết nối mạng.
- **Core (khuyến nghị cho cá nhân & cập nhật)**: Bộ cài gọn nhẹ (~39 MB); tải siêu nhanh trong vài giây và tự động nhận diện/sử dụng toàn bộ compiler đã có trên máy.

---

## Nền tảng hỗ trợ

- **Windows**: Windows 10/11 x64.
- **macOS**: macOS 11 trở lên trên Apple Silicon (M1/M2/M3/M4...).
