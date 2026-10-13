# Windows launch: từ chối hạ cách ly khi gặp lỗi 623

Ngày: 2026-10-11. Phạm vi: native executor Windows, không thay đổi OSD, giao thức online judge, scoring, giao diện, dependency hoặc version.

## Vấn đề đã xác minh

Cả `WindowsPlatform::run_inner` và `spawn_child_process` trước đây gọi lại `CreateProcessW` khi lần đầu trả lỗi 623. Lần gọi lại chỉ giữ handle-list và Job-list; bỏ security capabilities/AppContainer và chính sách LPAC. Job Object giới hạn tài nguyên không thay thế cách ly filesystem/network. Đây là nhánh tự hạ cách ly, không phải bằng chứng rằng mọi bài chấm trước đây đã thoát sandbox.

Microsoft định nghĩa 623 là `ERROR_ILLEGAL_DLL_RELOCATION`; mã lỗi này tự nó không chứng minh chương trình là 32-bit hoặc mọi compiler Themis không tương thích. Xem [System Error Codes](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--500-999-) và [cách thiết lập AppContainer bằng process attributes](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer). Không dùng sự tương thích với toolchain cũ để tự cấp thêm quyền.

Threat model: executable của bài nộp/compiler/checker đi qua biên executor → Windows. Tài sản cần bảo vệ là dữ liệu kỳ thi, thư mục cá nhân, các workspace khác và mạng. Lỗi của loader không được làm thay đổi quyền được duyệt trước khi chạy.

## Thay đổi

- Hai caller dùng chung adapter gọi Windows đúng một lần, giữ nguyên flags tạo suspended process, handle-list, Job-list và security attributes đã chuẩn bị.
- Bỏ cả hai nhánh retry 623. Giữ mã lỗi gốc; diagnostic nói rõ không retry với cách ly yếu hơn và đề nghị toolchain/executable tương thích. Không tự chọn compiler khác.
- Giữ nguyên mapping lỗi cấp phát memory ở lúc tạo tiến trình: submission → MLE; interactor → JE.
- Nếu không tạo được interactor sau khi đã tạo submission suspended, terminate Job của submission, chờ handle của chính tiến trình đó và xác minh Job rỗng trước khi trả kết quả. Dùng ngân sách cleanup 20 giây. Nếu không chứng minh được cleanup, executor thoát fail-closed thay vì trả một acknowledgement có thể cho phép dùng lại run ID khi tiến trình còn tồn tại.
- Hook ép lỗi chỉ tồn tại trong `cfg(test)`, dùng thread-local và reset theo RAII. Không có environment/IPC switch kích hoạt hook trong production.

Code: [Windows caller](D:/Minh/Code/judgedesk/native-executor/src/platform/windows.rs), [launch adapter và cleanup](D:/Minh/Code/judgedesk/native-executor/src/platform/windows/launch.rs), [regression tests](D:/Minh/Code/judgedesk/native-executor/src/platform/windows/tests/launch_failure.rs).

## Tiêu chí nghiệm thu và bằng chứng

RED đã quan sát trước khi sửa logic: ba test về startup, chạy đơn và interactive thất bại vì đếm được **2 lần tạo tiến trình thay vì 1**. Test đối chứng phân loại lỗi khác vẫn PASS. Sau sửa, sáu test hồi quy PASS:

| Trường hợp | Tiêu chí |
|---|---|
| Submission, compiler, checker, checker-runtime, security probe và regular AppContainer runtime | Lỗi 623 chỉ có một launch attempt; không child được tạo; diagnostic còn mã 623; không output, không active run |
| Startup self-test | Một attempt, `ready=false`, diagnostic giữ 623 |
| Interactive: lỗi submission hoặc interactor, cả checker native và checker-runtime | Không retry/later spawn; JE cho 623; nếu child đầu đã tạo thì duplicate handle của chính child phải signaled ngay khi hàm trả về |
| Memory/access-denied lúc create | Giữ MLE/JE/launch-error theo role, không retry |
| Cleanup không thể xác minh | Subprocess test với handle không hợp lệ phải thoát 1; không được trở về bình thường |
| Launch thành công | Chương trình test vô hại chạy, có output và thoát 0; active run được dọn |

Ép lỗi kiểm chứng control flow, không phải tái hiện loader lỗi 623 trên một binary Themis cụ thể. Kiểm chứng denial thực tế của kernel được thực hiện riêng bằng `npm run test:security`; test launch thành công đơn lẻ không chứng minh tất cả biên filesystem/network.

## Kiểm chứng toàn dự án

| Kiểm tra | Kết quả |
|---|---|
| `npm run check:fast` | PASS, TypeScript và quality invariant gate |
| `cargo clippy --locked --manifest-path native-executor/Cargo.toml --all-targets -- -D warnings` | PASS |
| `cargo test --locked --manifest-path native-executor/Cargo.toml` | PASS: 102 library + 5 binary tests, 0 fail/ignore; gồm 6 test hồi quy |
| `npm run test:server` | Lượt toàn bộ cuối chạy riêng: PASS, 122 file, 844 tests, 834 PASS, 0 FAIL, 10 skip có sẵn, 168,9 s |
| `npm run test:security` | Lượt toàn bộ cuối chạy riêng: PASS, 17 tests, 16 PASS, 0 FAIL, 1 skip đặc thù macOS, 115,0 s |
| `npm run check:full` | FAIL: Rust aggregate 8/9 bước PASS; chỉ core `executor_boundary_test` FAIL. Chuỗi dừng trước server/parity/version; các gate này chạy riêng, không tính là full PASS |
| `npm run test:themis-parity` | PASS: 67 fixtures trên Node, Rust, compiled C++ và packaged checker binaries; đây là static corpus parity, không phải live Themis DLL oracle |
| `npm run release:check-version` | PASS: 8 file đồng bộ 1.5.5, không bump version |

Full-gate blocker được tái hiện bằng focused test:

```powershell
cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml --test executor_boundary_test packaged_executor_resolution_rejects_debug_fallback_and_verifies_frozen_identity -- --exact --nocapture
```

SHA-256 binary đã build: `A418E392CA1527AC35CD2C5985D2CDB00B4CE7092A44493B398B987DD43779A2` (952320 bytes). Pin trong `crates/judgedesk-core/tests/executor_boundary_test.rs` vẫn là `EAB2EDDA46C732585E38AAA08E1E0DA2248818F803376E032CA63EB7D8918622` (950784 bytes). Lỗi mismatch cùng pin này đã có trong lượt đánh giá trước thay đổi hiện tại; thay đổi native lần này cũng tạo binary khác, nên cần quy trình review/refreeze artifact identity có chủ ý trước khi full gate/release được coi là PASS. Không đổi pin, golden fixture, threshold hoặc bỏ test để làm gate xanh.

Quality gate ban đầu phát hiện test file tách riêng chưa khai báo `cfg(test)` ở chính file; đã đặt toàn bộ nội dung dưới test-only module, không sửa checker hoặc nới quy tắc runtime Rust. Gate sau sửa PASS. Review năm trục không có phát hiện actionable còn lại trong phạm vi diff.

Lượt server đầu chạy cùng các gate nặng có 844 tests, 832 PASS, 2 FAIL, 10 skip, 461,1 s. Hai failure:

- Test oversized compiler output kỳ vọng `GENERATED_FILE_TOO_LARGE` nhưng nhận `COMPILER_TIMEOUT`. Chạy riêng đúng test bằng repo wrapper: PASS (1/1), không đổi code/timeout.
- Corpus `complete_group` kỳ vọng test 01 AC nhưng nhận TLE. Chạy lại toàn file corpus riêng: PASS (11/11), gồm mọi case C/C++, Java, Pascal, Python checker/interactor, Scratch và điểm rational; 243,5 s, 0 skip.

Sau các focused run, chạy lại **toàn bộ** `npm run test:server` riêng PASS (834/834 ca được áp dụng, 122 file, 168,9 s), giữ nguyên 10 skip có sẵn. Không chỉnh code/timeout/golden fixture để làm các timing failure xanh. Lượt này cũng PASS golden API 30/30.

Lượt corpus lọc theo một test không hợp lệ vì suite khởi tạo `manifest` trong test schema chạy trước; lần chẩn đoán đó báo `manifest` undefined. Không sửa suite hoặc bỏ assertion; kết quả có ý nghĩa là lượt **toàn file** 11/11 sau đó.

Lượt security đầu có 17 tests, 13 PASS, 3 FAIL, 1 skip macOS, 571,1 s. Hai Python boundary nhận `wall_time_limit` thay vì `exited` (wall-time khoảng 2 giây, không phải lỗi 623); assertion `terminalResultReceived` ngay sau cancel của checker-runtime nhận false. Focused run sau khi các gate khác kết thúc PASS 3/3 (15,9 s), rồi chạy lại **toàn bộ** security riêng PASS 16/16 ca được áp dụng (115,0 s); không đổi code/timeout/assertion. Có bằng chứng failure phụ thuộc điều kiện chạy, nhưng chưa phân biệt được scheduler/I/O contention với race ở promise client; không tuyên bố đã sửa một nguyên nhân chưa được chứng minh. Các bài test này không cho thấy successful unauthorized access.

Kết luận nghiệm thu: phần thay đổi có RED/GREEN, native tests/Clippy, server và kernel-security evidence đạt; **toàn bộ project chưa đạt `check:full` và chưa được xác nhận sẵn sàng commit/release** vì frozen identity blocker nêu trên. Các lệnh test/build của lượt này đều đã kết thúc.

## Khác biệt người dùng nhìn thấy

Với executable tương thích và sandbox khởi động được, quy trình/giao diện không đổi. Khi gặp lỗi 623, bài hoặc checker bị từ chối chạy; phần chi tiết lỗi có nguyên nhân và hướng khắc phục, thay vì chương trình được chạy lại ngoài AppContainer. Lỗi ở runtime submission ánh xạ `launch_error` → JE; interactive trả JE. Startup probe lỗi khiến secure runner không sẵn sàng.

Giới hạn UX hiện tại: compiler trả `compileStatus=CE` cùng `failureKind=infrastructure`, nhưng `judge-session.ts` vẫn chưa dùng provenance này. Vì vậy lỗi khởi động compiler trong luồng desktop có thể hiện CE dù diagnostic là lỗi host. **Đợt này chưa sửa phân loại CE/JE đó**, và không tuyên bố toàn bộ lỗi compiler đã được hiển thị đúng end-to-end. Không thêm dialog/locale hoặc kiểm thử GUI trong thay đổi backend-only này.

Nếu cleanup không được xác minh, executor dừng; các request đang dùng executor có thể nhận lỗi hạ tầng. Đây là hành vi fail-closed có chủ ý, không được che bằng một lần chạy lại yếu hơn.

## Còn lại, ngoài phạm vi

- Các đường `resource-only` được chọn ngay từ đầu (Pascal/Scratch/local policy), default/recovery/migration của execution policy chưa được sửa. Loại bỏ retry 623 **không** làm các đường ấy trở thành strict.
- Các nhánh lỗi interactive khác sau khi hai child đã tạo, cùng teardown tổng thể, cần audit riêng; lần này sửa ranh giới thất bại ở lần tạo child thứ hai.
- Phân loại lỗi compiler hạ tầng ở desktop; readiness/effective isolation xuyên ngôn ngữ; backend Rust thực nghiệm.
- Không kiểm chứng runtime macOS, không đóng gói installer, commit, push hoặc phát hành.

Skill TDD tạo bằng chứng RED/GREEN; security-and-hardening giữ scope theo trust boundary; phản biện độc lập bổ sung cleanup verification và startup coverage. Người dùng đã chọn bỏ qua phản biện chéo bằng mô hình khác. Review cuối đánh giá correctness, readability, architecture, security và performance; tiêu chuẩn trong CONSTRAINTS.md được giữ nguyên.
