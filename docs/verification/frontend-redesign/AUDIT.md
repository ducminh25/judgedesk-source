# FR0 — Audit giao diện bản cài

Ngày 2026-10-03. Bản cài 1.5.1 / 4d6c068324a3 / local; source HEAD tại intake
8bc8ac9a2161a7468b633c421185d039c97e5a68. Findings phải được đối chiếu source
trước khi sửa. Evidence: 33 PNG trong `artifacts/FR0`, 26 ảnh phiên fixture có
metadata tại `manifest-20261003-session2.json`; 7 ảnh đầu trong BASELINE.md.
Ảnh 1282×831, VI, DPI chưa đo. Đây là audit đại diện, chưa là accessibility audit.

## Ưu tiên thiết kế

| ID | Priority | Quan sát và evidence | Hướng xử lý cần thử |
|---|---|---|---|
| UI-006 | High | Stress 20 bài: header xuống dòng mỗi 1–3 ký tự, trong cả light/dark (`installed-*-vi-stress-unjudged-1282x831.png`). Thihay 5 bài đọc được | Giữ chiều rộng tối thiểu cột bài, một dòng tên với cơ chế xem tên đầy đủ; horizontal scroll có chủ đích; giữ cột tên/tổng điểm dễ theo dõi |
| UI-007 | High | Problem config: vùng settings cố định chiếm khoảng nửa modal; testcase ở vùng cuộn còn ít dòng. Interactive thêm một hàng; nhiều panel lồng nhau (`config-AplusB-top`, `config-interactive`, `thihay-config-CAU1`) | Thử tách Cơ bản / Testcases & nhóm / Biên dịch trong cùng modal; footer lưu/hủy luôn hiện; không bỏ field hay thay nghĩa config |
| UI-008 | Medium | Nhóm + nội dung test khiến action GIỚI HẠN THỜI GIAN xuống nhiều dòng (`config-group-policy`, `config-test-content`) | Tách action khỏi nội dung biến độ dài; dùng label ngắn + tên accessible đầy đủ, giữ khả năng thao tác hàng loạt |
| UI-009 | Medium | Nút toolbar nhiều màu; cột tổng điểm phủ tím; hierarchy chưa thống nhất (`stress-verdicts`, `thihay-unjudged`) | Surface trung tính, border 1px; accent chỉ cho hành động chính/focus/selection; verdict có màu semantic nhất quán |
| UI-010 | Medium | WA/RE/TLE cùng hiển thị điểm 0 trong scoreboard. Details mới cho biết loại lỗi (`stress-verdicts`, `details-WA-open`) | Thử verdict hint cạnh điểm/tooltip, giữ điểm rational và ranking; không suy diễn verdict từ điểm |
| UI-011 | Medium | Dark WA: heading actual đỏ trên nền rất tối; CE light dùng tím cho compiler error (`installed-dark-vi-details-WA`, `installed-light-vi-details-CE`) | Đo contrast tokens và thống nhất error semantic; không tuyên bố tỷ lệ contrast từ ảnh |
| UI-012 | Low | Log lặp tên bài/thí sinh mỗi testcase, lỗi compiler có horizontal scroll (`scoring-log`) | Thử grouping và hierarchy; vẫn xem/copy đầy đủ diagnostics |

UI-001..005 (toolbar, type, paths, empty state, build identity) giữ trong BASELINE.md.
Cursor glow là dấu hiệu môi trường capture, chưa quy cho styling app. Frame ngay
sau đổi theme không dùng làm bằng chứng theme bug.

## Fixtures và kết quả khảo sát

Copies tại `D:\Minh\Code\judgedesk-ui-audit\20261003`, tách khỏi repo/dữ liệu thật.
Stress: 20 bài, 9 contestants an toàn AC_cpp, AC_python, WA_cpp, CE_cpp, RE_cpp,
TLE_cpp, Weighted_Partial_cpp, Group_PassAll, Group_PassA_FailOneB. Không dùng
Sec_* hoặc ZZ_DANGEROUS_*. Chỉ chấm A_plus_B: AC_cpp/AC_python 5/5, CE_cpp CE,
WA/RE/TLE 0/5; ba contestants còn lại không có bài A_plus_B. Đã quan sát progress,
diff expected/actual, compiler diagnostics và aggregate log. Đây không là kiểm
chứng engine. Snapshot lưu qua UI tại `stress-baseline.judgedesk` (440636 bytes).

Thihay: 5 bài CAU1..5, 15 contestants đổi tên Audit_01..15. Không copy DOCX,
ảnh danh sách hoặc _temp_judge. Quan sát main light/dark và CAU1 File I/O/checker
light; chưa chấm bộ này. Các modal config đều Hủy; không lưu toggle nhóm/interactive.

## Coverage và phần còn lại

Đã có: main empty/populated light+dark, Tools light+dark ổn định, config top/tests/
groups light+dark; interactive/content light; mixed verdict light+dark; WA details
light+dark; CE/log/help light; directory dark; toolchain manager/OSD off light;
new contest và native Save As đã thao tác, không lưu ảnh native dialog riêng.

Cần bổ sung trước acceptance của batch liên quan: EN main/config, cửa sổ hẹp,
keyboard Tab/focus trap/return focus, đo contrast, Help/OSD/toolchain dark, prompts
validation/unsaved/update. Không install/update/delete hoặc bật watcher để lấy ảnh.
NOT_OBSERVED không là PASS. FR0 representative baseline đã đủ để bắt đầu FR1;
các mục trên vẫn là verification debt bắt buộc trước FR7.

## Bước tiếp theo — FR1

Đối chiếu source component và primitives với evidence. Tạo hai phương án light
cho scoreboard + Problem config với cùng fixture 5/20 bài. Khuyến nghị hướng
desktop trung tính: chữ rõ, mật độ dữ liệu cao, cột không bóp tên, ít panel lồng,
accent tiết chế. Phương án phải thể hiện cả selection/focus/verdict, không chỉ
empty state. Chỉ sau đó chốt tokens và triển khai từng batch theo plan.

Không nhập nguyên skill evondevKit: chọn hướng dẫn audit/reuse/state phù hợp;
loại quy tắc ẩn focus và style trái CONSTRAINTS. Không thêm dependency.

## Review và gate

Thay đổi lượt này chỉ là tài liệu/evidence. Review: không đổi runtime/architecture,
scoring/sandbox/version/dependencies, không ghi dữ liệu thí sinh thật trong ảnh,
không chạm migration. Chưa chạy check:fast/server/full hoặc test:desktop; không
có runtime PASS. Sau mỗi frontend batch: restart test:desktop, inspect native UI,
chụp before/after và cập nhật log như plan.
