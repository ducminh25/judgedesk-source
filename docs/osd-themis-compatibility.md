# OSD tương thích web Themis — đợt triển khai đầu

Ngày: 11/10/2026. Backend được sửa: Express/Node của JudgeDesk 1.5.5. Không đổi phiên bản, dependency, cấu hình sandbox hay backend Rust thử nghiệm.

## Kết quả và phạm vi

Đã triển khai lớp nhận bài/xuất log để host giữ hợp đồng filesystem của web Themis: đặt OSD của JudgeDesk vào thư mục `data/submit` của web, bật log, chọn thư mục bài làm và đề/test tương ứng. Chỉ một engine (Themis **hoặc** JudgeDesk) được theo dõi cùng inbox tại một thời điểm.

Đây là nền móng thay engine, không phải xác nhận một online judge công khai đã sẵn sàng. Chưa chạy toàn bộ web cũ trong trình duyệt, chưa kiểm thử bản đóng gói hay macOS cho thay đổi này. Không mở HTTP ra Internet và không thay authentication/CORS.

Nghiên cứu đối chiếu source upstream ở commit cố định `d0cc685330f1d572b977ea73685ff5396323d15e`:

- [Producer routes/submit.js](https://github.com/natsukagami/themis-web-interface/blob/d0cc685330f1d572b977ea73685ff5396323d15e/routes/submit.js).
- [Reader controls/judgelog.js](https://github.com/natsukagami/themis-web-interface/blob/d0cc685330f1d572b977ea73685ff5396323d15e/controls/judgelog.js).
- [Scoring controls/scoring.js](https://github.com/natsukagami/themis-web-interface/blob/d0cc685330f1d572b977ea73685ff5396323d15e/controls/scoring.js).

Reader được giữ nguyên trong fixture kèm giấy phép MIT và checksum. Test thực thi reader thật; các dependency locale, persistence và debug dùng doubles có phạm vi ghi rõ trong README fixture. Không cài dependency của web đã lưu trữ.

## Hợp đồng tương thích

| Mục | Hành vi |
|---|---|
| Tên producer cũ | `0[HS01][SUM]cpp`, không có dấu chấm |
| Tên OSD hiện có | `prefix[HS01][SUM].cpp` vẫn được chấp nhận |
| Phần mở rộng | Theo registry ngôn ngữ đang có; parser không bảo đảm compiler/runtime đã sẵn sàng |
| Đề | Khớp danh sách đề của phiên; giữ quy tắc tìm tên đề không phân biệt hoa thường |
| Thí sinh | Giữ nguyên identity an toàn; không tự thay ký tự nguy hiểm thành dấu gạch dưới. Từ chối alias thư mục khác cách viết trên filesystem không phân biệt hoa thường |
| Output | `logs/<tên-input-nguyên-gốc>.log`, chữ thường `logs`, UTF-8 và CRLF |
| Dòng đầu | `HS01‣SUM: <số-thập-phân-hoặc-lỗi>` |
| Block testcase | Generic 3 dòng; TLE 2 dòng; RE 3 dòng theo reader cũ |
| Điểm | Rational trong engine. Log là **presentation** 6 chữ số thập phân; làm tròn bằng BigInt, không đưa ngược vào scoring |
| CE | Lỗi compiler do bài nộp, dựa trên provenance của kết quả process, không suy ra từ text stderr |
| Lỗi host | Nonnumeric `ℱ Lỗi hệ thống chấm`; không phát event problem-completed hoặc partial score hợp lệ |
| Log/history | Ghi tạm, fsync, rename; không follow junction/symlink của các thư mục đích |

Với điểm không có biểu diễn thập phân hữu hạn, ví dụ `1/3`, web cũ nhận `0.333333`, còn JudgeDesk giữ `{ n: 1, d: 3 }`. Không tuyên bố bảng xếp hạng của web cũ chính xác rational: nó dùng Number, có giới hạn độ lớn và có thể tạo tie do làm tròn.

## Danh tính nguồn và vòng đời

Nhận bài bằng rename cùng filesystem vào thư mục riêng `.judgedesk-osd-*` **trước** khi chờ ổn định. Đọc bằng descriptor của file đã claim, kiểm tra inode/device, size, mtime và ctime, copy theo chunk, hash SHA-256. Mỗi job có path riêng. Trước khi chấm, kiểm tra lại ownership, metadata và hash.

`Contestants/HS01/SUM.cpp` chỉ là bản nguồn mới nhất để xem trên desktop, không phải source của job. Các bản desktop cũ chuyển sang `$History` với tên UUID. Failed admission được giữ ở `Rejected` nếu ghi được; nếu thư mục phục hồi không an toàn/không ghi được, file riêng được giữ lại và báo lỗi, không quét xóa toàn inbox.

Snapshot được giải phóng khi job kết thúc bằng unlink file + rmdir **thư mục lá rỗng đã sở hữu**, không dùng recursive delete. Cleanup thất bại giữ ownership; lần bắt đầu tiếp theo thử lại và báo lỗi cụ thể nếu vẫn không dọn được.

Các thư mục riêng tồn tại sau crash là dữ liệu cần phục hồi, không phải rác được phép xóa tự động. Chưa có journal/durable queue hay recovery tự động sau crash.

Mỗi job giữ root của phiên và normalized problem config tại admission. Bắt đầu phiên mới không kế thừa request overrides của kỳ thi trước. Toolchain được resolve/pin trong lượt chấm; không có compiler fallback. Các file test/checker trên đĩa chưa được snapshot, vì vậy host phải giữ chúng bất biến khi chấm.

Chính sách kết quả là **latest accepted** theo contestant/problem. Các job cũ vẫn được chấm, nhưng không publish log/scoreboard completion đè kết quả của bài mới hơn. Đây không phải best-score policy hay submission-history API. Legacy basename chỉ có một log; prefix tùy ý không tạo receipt lịch sử cho mỗi job.

## Vấn đề, kiểm thử và tiêu chí đạt

| Vấn đề đã tái hiện | Kiểm thử/tiêu chí |
|---|---|
| Web nộp tên không dấu chấm nhưng parser chỉ nhận tên có chấm | Nhận cpp/pas/py/java đúng shape producer; vẫn nhận dotted names; từ chối suffix không hỗ trợ |
| Log trang trí cũ không đúng layout reader | Reader upstream đọc đủ AC/WA/TLE/RE/CE; tìm đúng file trên filesystem; CRLF không phụ thuộc host |
| Job A trỏ vào file chung bị B ghi đè hoặc C đổi ngôn ngữ làm mất | Ba jobs có ba paths riêng; bytes A/B/C và hash giữ đúng; latest desktop là C |
| File đang ghi cùng kích thước được coi là ổn định | Writer giữ descriptor và ghi liên tục quá retry budget: không có job, báo SOURCE_NOT_STABLE |
| Stop cắt vòng testcase rồi xuất kết quả thiếu test | Dừng intake giữa Test01/Test02: vẫn chạy cả hai, điểm exact 2/3; nguồn được dọn sau terminal |
| Restart trong lúc rollback intake cũ | Start bị từ chối đến khi pending claim cũ settle; không phục hồi nguồn cũ vào giữa phiên mới |
| Phiên mới lấy defaultScore kỳ thi trước | Contest mới có Config.cfg tối giản: dùng defaults/stored config mới, không dùng overrides cũ |
| Thiếu compiler / AC rồi JE bị quy thành CE hay điểm partial | Job failed, không result số, log lỗi host nonnumeric |
| Stderr thí sinh giả text lỗi host | Compiler exit khác 0 vẫn được phân loại submission; sandbox/launch/internal failures không thành CE do thí sinh |
| Junction/hardlink/identity alias | Không đọc nguồn hardlinked, không ghi ngoài root qua contestant/log junction; không gộp HS01 và hs01 trên host case-insensitive |
| Cleanup lỗi tạm thời khóa service vĩnh viễn | Không xóa file lạ trong owned leaf; khi host gỡ cản trở, start retry cleanup thành công |

Các test service dùng doubles ở boundary compiler/checker/test runner để điều khiển scheduling và lỗi một cách xác định. Chúng dùng filesystem, watcher và gate thật nhưng **không** chứng minh thực thi sandbox end-to-end của OSD. Suite toàn dự án kiểm tra thêm các luồng compiler/executor hiện có.

## Khác biệt UX

Không thay giao diện, theme, keyboard hay bố cục. Người dùng sẽ thấy:

- Tên bài do web Themis tạo được nhận trực tiếp; không phải đổi quy tắc đặt tên.
- Nộp lại/đổi ngôn ngữ không làm lượt chấm đã nhận dùng nhầm source.
- “Dừng lắng nghe” ngừng nhận bài mới; bài đã accepted vẫn xử lí hết. Pause chỉ hoãn queue, không hủy job đang chạy.
- Bật lại/đổi phiên khi còn nhận/chấm bài sẽ nhận thông báo phải đợi; sau cleanup lỗi, thông báo chỉ rõ cần kiểm tra quyền/file khóa rồi thử lại.
- Điểm desktop vẫn exact theo engine. Log dành cho web là decimal. Các diagnostic nhiều dòng trong block testcase được gom thành một dòng để không phá parser.

Job failed được báo qua SSE hiện có. Chưa thêm màn hình lịch sử, nút retry job, dashboard host hay chế độ headless. Tên đường dẫn nguồn trong SSE là path riêng tạm thời, không còn là path desktop ổn định và có thể không tồn tại sau terminal.

## Điều kiện vận hành và giới hạn bảo mật

1. Inbox, Contestants, đề/test và **mọi thư mục tổ tiên** phải do host kiểm soát quyền ghi. Chỉ service web/host và JudgeDesk được ghi inbox. Không cấp Everyone/SMB writable cho thí sinh khi dùng cầu nối web. chmod không thiết lập DACL riêng trên Windows; host phải cấu hình ACL phù hợp.
2. Đây không phải bảo vệ chống attacker có quyền đổi ancestor/sửa thư mục private giữa lstat và open/rename. Node portable APIs không cung cấp đầy đủ directory-handle-relative transactions trên Windows. Không coi các check link là thay thế sandbox.
3. Producer legacy dùng write-in-place và tái sử dụng basename. Có thể mất request **trước claim**, và khoảng im lặng không chứng minh writer đã hoàn tất nếu nó tạm dừng lâu hơn debounce. Producer mới nên write temporary rồi atomic rename, dùng unique submission ID/receipt. Chưa bắt web cũ thay giao thức trong đợt này.
4. Web cũ quy verdict nonnumeric thành 0 trong Scoring.add. Log JE mới không tự sửa chính sách scoreboard đó. Host cần điều chỉnh trạng thái infrastructure-error/retry trước khi dùng thi thật đòi hỏi công bằng khi máy chấm lỗi.
5. OSD interactive chưa nối interactor, nên fail rõ thay vì chấm sai. Chấm interactive thủ công không bị đổi. ZIP nhiều-file Themis không được thêm hỗ trợ ở đợt này.
6. Queue nằm trong RAM, chưa có quota số job/source bytes, journal, crash recovery, retry/dedup bền vững hoặc per-job API. Không triển khai public Internet với lớp này một mình.
7. Không thay sandbox hoặc các policy resource-only đang có. Kết quả phân tích trước đó vẫn cần được xử lí/kiểm chứng độc lập trước khi cho thí sinh không tin cậy truy cập một host online công khai.
8. Đây là backend Node. Backend pure-Rust thử nghiệm chưa được bổ sung OSD và không được tuyên bố cùng mức tương thích.

## Review và xác minh

Áp dụng TDD (các lỗi trọng tâm có RED trước sửa), security-and-hardening (trust boundaries + host-only ACL), doubt-driven-development (review độc lập, người dùng chọn bỏ qua cross-model), code-review-and-quality và hợp đồng CONSTRAINTS hiện có. Không hạ gate, thêm suppression, dependency hay bỏ test. Assertions log cũ được cập nhật vì hợp đồng wire thay đổi; các ý nghĩa rejected/completed/atomic-write được giữ và mở rộng.

Các findings phản biện về score presentation, scoreExact bị mất, lỗi compiler/JE, mutable session, stability/claim và ownership đều actionable và đã sửa. Các giới hạn producer legacy, decimal scoreboard, durable queue, ancestor ACL và interactive được phân loại trade-off/phạm vi có giới hạn nêu trên, không tuyên bố đã giải quyết.

Review cuối còn chỉ ra pending-claim restart race, stale contest overrides, filesystem aliases và cleanup retry; mỗi lỗi có regression RED → GREEN.

Kết quả verification sẽ được ghi tại đây sau khi các lệnh hoàn tất.

