# JudgeDesk hardening — tiến độ 2026-10-12

Phạm vi: triển khai tuần tự 6 bước đã được người dùng duyệt. Không triển khai OSD,
không commit/push/phát hành, không thêm dependency, không hạ CONSTRAINTS.md.

| Bước | Trạng thái | Điều kiện nghiệm thu |
|---|---|---|
| 1. Artifact/full gate | PASS trên Windows host này | Build sạch tái lập, frozen identity đúng, full gate và đối chiếu cuối PASS |
| 2. CE và lỗi hạ tầng | PASS full gate Windows; native matrix đã quan sát, giới hạn UX ghi bên dưới | Provenance xuyên compiler/session/scoring/UI/export; syntax CE không đổi |
| 3. Local execution policy | 3A gates/native scoped matrix xong; 3B focused/full gate qua, native in-place còn lỗi | Default/recovery fail-closed; migration/import không tăng quyền; readiness trung thực |
| 4. Sandbox từng ngôn ngữ | Chưa triển khai | Không resource-only cho untrusted code; positive/negative kernel tests từng vai trò; macOS cần host thật |
| 5. Backend/API desktop | Chưa triển khai | Không automatic experimental fallback; API phiên/Origin/Host/SSE và CSP được kiểm thử |
| 6. Vòng đời và determinism | Chưa triển khai | Cancel/error/shutdown drain hoàn toàn; terminal một lần; điều tra timing failure bằng bằng chứng |

## Bước 1 — nguồn gốc và artifact identity

CLAIM: refreeze có chủ đích giữ nguyên exact identity gate, không lấy hash bất kỳ
của binary hiện có làm kỳ vọng động. Cần bind nguồn, recipe và candidate đã chấm.

- RED: focused Rust boundary test tái hiện pin cũ EAB2… khác A418… (952320 bytes).
- Một lần xóa top-level release executable chỉ làm Cargo khôi phục từ `deps`,
  không phải relink; không tính làm bằng chứng tái lập.
- Relink thật (xóa đúng hai output `.exe` đã kiểm tra containment, không source)
  tạo hash 131810… với cùng nguồn. Timestamp PE đổi từ 1791735502 sang 1791766833.
- Sửa Windows recipe thành `cargo rustc --locked --release --bin
  judgedesk-native-executor -- -C link-arg=/Brepro`, giữ target/manifest/VS env.
  macOS giữ recipe cũ. Cờ chỉ áp dụng standalone executable.
- Test recipe RED (thiếu export), GREEN 2/2. Hai lượt clean `native-executor/target`
  release đúng target (xóa cache build có thể tái tạo, không dữ liệu người dùng),
  rồi build mới cả dependencies: 26,66s và 34,64s, cùng SHA-256
  `9E7359984262F224E0864BCDE0F66CE9B655F3870E077364C9A733D55129D41A`, 952320 bytes.
- Chuẩn hóa LF cho native identity inputs và build recipe/helper; không đổi
  semantic/version. Build fingerprint: `010889c83420c499b3480e3956484bc9c6847362834bbe8b8291382a582fa759`.
- Hồ sơ JSON `executor-freeze-2026-10-12.json` băm đầy đủ `.rs`, kể cả test/macOS,
  build.rs, Cargo files, Rust pin, attributes và build recipe/helper/npm manifest.
- Giữ pin literal, path/no-debug assertions; bổ sung control byte-tampering cùng
  kích thước và truncated bytes. Focused boundary GREEN 1/1 sau refreeze.
- Phản biện độc lập xác định raw-byte line endings, true-clean rebuild,
  post-gate identity và MSVC/SDK portability là các yêu cầu. Người dùng chọn bỏ
  phản biện chéo; tiếp tục bằng phát hiện của reviewer hiện có.

Giới hạn: chỉ chứng minh same-host/same-input determinism. VS helper chọn latest
installation; receipt ghi VS17.14.37502.11, MSVC14.44.35207, SDK10.0.26100.0,
Rust1.97.1, không có ambient Rust overrides. Không tuyên bố mọi Windows CI image
build ra cùng bytes. Native input/recipe thay đổi phải refreeze lại có review.

`npm run check:full` PASS: check:fast; 9/9 Rust fmt/clippy/test steps;
test:server 847 tests / 837 PASS / 0 fail / 10 conditional skips có từ trước;
67-fixture checker parity cả Node/Rust/C++/Windows packaged; version lockstep 1.5.5.
Sau full gate, SHA-256/size staged executable vẫn khớp exact pin và cả 30 raw
source inputs khớp receipt. `git diff --check` sạch. Reviewer cuối không còn
finding actionable; byte controls không được coi là mutation test rejection path.
Không tuyên bố native macOS runtime PASS hoặc Windows CI portability đã kiểm thử.

## Bước 2 — CE / JE (full gate PASS, giới hạn native UX ghi rõ)

CLAIM: provenance từ compiler phải giữ đến session, summary, UI và export;
JE không phải lỗi nguồn học sinh và không biến thành AC/PARTIAL khi tests rỗng
hoặc đã có một test AC. Testcase evidence được giữ, aggregate JE không có điểm
hợp lệ. Không sửa thuật toán ranking/rational của các kết quả hợp lệ.

Review design độc lập phát hiện: Java comment-only có thể exit 0 không sinh class,
validator Java cần phân loại CE trước generic artifact-empty guard; summary JE
ở runtime cũng cần label đúng (compile stage có thể OK); corpus harness phải dùng
shared CompileStatus, không union ad-hoc. Các phát hiện actionable được tiếp thu.
Người dùng chọn bỏ phản biện chéo bước 2; không gọi CLI ngoài.
Historical saved CE giữ nguyên, không đoán ngược nguyên nhân cũ.

Đã thay đổi:

- Shared CompileStatus thêm JE; lỗi có marker StudentCompilationError vẫn CE,
  lỗi môi trường/khởi chạy/cấu hình là JE. Không phân loại bằng nội dung diagnostic
  hoặc cause lồng nhau; compiler/runtime không sẵn sàng ở 10 ngôn ngữ không fallback.
- Java comment-only/không có class và package layout không hỗ trợ là lỗi nguồn;
  lỗi filesystem vẫn là hạ tầng. Warmup do JudgeDesk sở hữu giữ ngữ cảnh JE.
- Summary ưu tiên JE trước AC/PARTIAL/CE; điểm aggregate không hợp lệ không được
  cộng/xếp hạng. JE trong COMPLETE_GROUP/dependent group không xóa evidence và
  scoreExact testcase. Quy tắc rational/group của kết quả hợp lệ không đổi.
- Test input được xác định không phải text bị từ chối trước compileSubmission,
  không ghi đè một lần compile OK thành JE. Hủy job không xuất bản JE đến muộn.
- Bảng điểm và tổng điểm hiện JE; kết quả không hợp lệ xuống vùng chưa có điểm ở
  cả hai chiều xếp điểm. Bỏ chọn bài JE khôi phục tổng các bài hợp lệ.
- Chi tiết, log và Excel phân biệt lỗi môi trường với CE. Kết quả cũ PARTIAL có
  testcase JE không còn hiện aggregate numeric grade; testcase và JSON không sửa.
- Corpus dùng CompileStatus canonical. Test Python unmanaged thay kỳ vọng CE thành
  JE; chỉ cập nhật fingerprint trong expected-skips, không thêm/đổi waiver hoặc skip.

TDD: scoring, compiler provenance, Java validation, session publish/cancel và
preflight test-plan, scoreboard/model, details, workbook đều có test trọng điểm.
Các phát hiện group evidence/header/Excel/warmup/test-plan được tái hiện RED rồi
GREEN; session đi qua compiler/session/scoring/event serialization thật, chỉ mock
executor startup boundary. Latest check:fast và git diff --check PASS.

Full gate lần đầu sau bước 2: native-executor và Rust core fmt/clippy/tests PASS;
Tauri clippy/tests FAIL vì build helper không thể xóa target/debug/server.exe đang
chạy trong test:desktop. Xác minh helper fs::remove_file và process path khớp;
đóng bản dev qua Alt+F4, sidecar thoát code0 và process không còn. Đang chạy lại
full gate tuần tự khi desktop đã đóng, chưa được ghi PASS trước khi hoàn tất.

Lượt chạy lại: 9/9 Rust gates PASS; server 864 tests / 853 PASS / 1 FAIL / 10
conditional skips cũ. Failure duy nhất là `testlib_matrix` vẫn kỳ vọng aggregate
PARTIAL và 3/2 điểm dù testcase 05 là JE. Đối chiếu source generator/manifest và
scoring contract: sửa riêng expectedProblemVerdict thành JE, expectedScore thành
0/1, bổ sung provenance giải thích; giữ nguyên mọi testcase verdict/score/message
và hash/size các fixture bytes. Materialize chỉ đổi manifest và source kỳ vọng.
Đang chạy full gate lại sau thay đổi này; parity/version chưa chạy ở lượt fail.

Lượt kế tiếp vẫn chỉ FAIL corpus: assertion chung buộc summary.scoreExact bằng
tổng điểm testcase không còn đúng cho JE. Đã giữ assertion này cho mọi kết quả
hợp lệ; JE nay phải có compile/testcase provenance JE và exact aggregate 0/1.
Các assertion từng testcase, manifest status/score/maxScore vẫn giữ. Focused
scoring 14/14 PASS; không đổi threshold hoặc bỏ kiểm thử nào.

Desktop: điều khiển Windows đã hoạt động lại sau lần dừng Escape. Gói fixture đầu
thiếu problem directories nên inventory trống; đã bổ sung fixture text ẩn danh.
Đã restart test:desktop, mở đúng fixture có 4 bài/1 thí sinh. Bảng điểm và chi tiết
phân biệt CE/setup JE/runtime JE; runtime vẫn compile OK và giữ testcase AC 0.5.
Bỏ chọn một bài JE vẫn tổng JE; bỏ chọn cả hai trả tổng 1.00; chọn lại trả JE.
Đã lưu screenshot normal 1536x792 cho đủ light/dark × VI/EN; đang kiểm tra narrow.
Escape đóng chi tiết và hiển thị focus ô bảng. Tab trong chi tiết chưa chứng minh
được focus confinement, không ghi PASS bàn phím toàn diện. Menu Công cụ phát sinh
React setState-in-render warning (callback trong updater AppToolbar đã có ở HEAD).
Sau startup Ready, menu báo native executor exited code0 trong lúc server corpus
chạy song song; chưa xác định nguyên nhân hoặc tái hiện khi chạy riêng. Không
coi fixture cached results là kiểm thử judging end-to-end.
Chưa hoàn tất native matrix light/dark × VI/EN × normal/narrow sau thay đổi;
static render không được coi là native acceptance. Chưa có baseline CE/JE screenshot
so sánh đủ điều kiện. macOS runtime NOT_RUN.

Code review độc lập đã đọc lại cả ba fix và không còn finding actionable trong
phạm vi đó; reviewer không tự chạy gate/native/UI, các bằng chứng được ghi riêng.
Repeated testcase scans trong scoreboard là ghi chú performance chưa benchmark,
không phải một hồi quy timing đã được đo. Không tuyên bố Rust backend experimental
có compiler-provenance parity; bước 5 sẽ xử lý admission/fallback của backend đó.

Nguồn tham khảo cho reproducible PE linking:
[LLVM](https://blog.llvm.org/2019/11/deterministic-builds-with-clang-and-lld.html),
[Microsoft BuildXL](https://github.com/microsoft/BuildXL/blob/main/Public/Sdk/Experimental/Msvc/Native/Tools/Link/Link.dsc).

Skill TDD/debugging tạo RED/GREEN và phân biệt restaging với relink; phản biện
doubt-driven bổ sung input closure/post-gate check; quality floor không thay đổi.
Tham chiếu phụ `definition-of-done.md` của shipping skill không có trong repo;
dùng guidelines.md/CONSTRAINTS.md và gate thực tế làm hợp đồng nghiệm thu.

## Điểm dừng an toàn theo yêu cầu người dùng

Tạm dừng lúc 2026-10-12 09:28 ICT (02:28 UTC) vì quota; chỉ tiếp tục khi người
dùng ra lệnh. Không khởi chạy gate mới, không sửa thêm logic, không commit/push.
Đã đóng bình thường bản test:desktop narrow; session 36261 kết thúc exit0,
sidecar thoát code0. Kiểm tra process không còn themis-v2/server/native executor.
Các reviewer đã hoàn thành, không có công việc agent nền còn chạy.

- Bước 1 đã PASS trên Windows host này; bước 2 chưa chốt nghiệm thu; bước 3–6
  chưa triển khai. OSD tiếp tục ngoài phạm vi.
- Full gate mới nhất vẫn FAIL duy nhất corpus assertion tổng điểm JE; đã sửa
  harness để giữ assertion tổng cho kết quả hợp lệ và kiểm tra provenance/0/1
  cho JE. Focused scoring 14/14 PASS, nhưng chưa rerun full sau fix cuối.
- Native normal đủ light/dark × VI/EN. Narrow 960x600 client đã quan sát/lưu
  dark EN và light EN; light VI/dark VI còn thiếu. Phiên narrow chạy riêng báo
  executor Ready, không tái hiện exit code0 đã thấy khi chạy corpus song song;
  chưa xác định nguyên nhân. Enter/Escape đã quan sát; Tab confinement chưa xác minh.
- Screenshot ở docs/verification/frontend-redesign/artifacts/ce-je-20261012/.
  Chưa có baseline CE/JE before đủ điều kiện. macOS runtime NOT_RUN.
- Fixture riêng artifacts/ce-je-ui/verified-fixture.judgedesk đã được lưu sau
  thử chọn/bỏ chọn; kết quả testcase giữ nguyên. Source fixture và narrow config
  còn tại artifacts/ce-je-ui/. Preferences lúc đóng là light/EN, chưa trả dark/VI.
- Giữ nguyên toàn bộ dirty tree và artifacts; không xóa hoặc hoàn nguyên dữ liệu.

Tiếp tục: đọc lại checkpoint và diff; hoàn tất hai native narrow VI states và
keyboard audit còn thiếu, đóng desktop trước khi chạy npm run check:full để tránh
sidecar lock. Sau gate đối chiếu frozen native artifact/source receipt. Chỉ chốt
bước 2 bằng bằng chứng thực tế, rồi bắt đầu design review/TDD bước 3.

## Tiếp tục sau lệnh của người dùng — 2026-10-12

Đã restart desktop bằng narrow overlay, backend port62693 / sidecar PID23236,
build1.5.5 HEAD938044 / dirty. Hoàn tất light VI/dark VI narrow 960x600 client;
lưu thêm scoreboard/runtime screenshots tại cùng thư mục audit. Như vậy bảng
điểm đã được quan sát đủ light/dark × VI/EN × normal/narrow. Runtime JE vẫn giữ
compile OK12ms và testcase AC0.5; aggregate JE. Toolbar tiếng Việt cần cuộn ngang
để tới Công cụ, không thu nhỏ font. Preferences đã trả dark/VI. Desktop session
16196 đóng bình thường exit0/sidecar code0, không còn process app/server/executor.

Tab trong details thực sự đi ra checkbox nền bảng; source details/log chỉ xử lý
Escape, chưa có focus trap hoặc aria-modal. Đây là thiếu sót đã có trước ở HEAD,
không phải thay đổi focus của batch CE/JE; không ghi PASS accessibility toàn diện.
Enter/Escape và visible cell focus đã quan sát; baseline before và macOS vẫn thiếu.
Không lấy fixture cached results làm chứng minh chấm end-to-end.

Full gate sau resume dừng ở TS2367: assert.strictEqual compileStatus với expected
OK/CE đã narrow kiểu, nên so sánh compileStatus===JE ở cuối harness là bất khả thi.
RED là check:fast thật. Sửa assertion JE thành bắt buộc có testcase JE (mạnh hơn
cho corpus hiện tại), giữ exact aggregate0/1 và mọi testcase/manifest assertion.
Lượt full tiếp theo đã qua check:fast và cả9 Rust steps; server suite đang chạy.
Log: artifacts/ce-je-check-full-resumed-fixed-20261012.log. Chưa ghi full PASS.

Bước3 chỉ đang nghiên cứu/design review read-only: không giảm sandbox tự động do
missing/recovery/migration/Themis import; readiness dựa strict automatic probe,
không bắt người dùng làm manual deep verification. Chưa sửa logic bước3 trong
lúc full gate đang xác minh candidate bước2.

### Kết quả gate cuối bước 2

`npm run check:full` kết thúc exit0: check:fast PASS, Rust9/9 PASS;
server864 tests / 854 PASS / 0 fail / 10 conditional skips cũ, 125 test files;
live corpus25 cases được xác minh; parity67 fixtures qua Node/Rust/C++/Windows
packaged; version lockstep1.5.5 PASS. Sau khi gate kết thúc, đối chiếu lại đủ30
raw inputs của freeze receipt và executable952320 bytes, SHA-256
`9e7359984262f224e0864bcde0f66ce9b655f3870e077364c9a733d55129d41a`: khớp.
Không suy diễn kết quả gate thành PASS focus confinement, macOS hoặc screenshot
baseline: các giới hạn native UX phía trên vẫn còn hiệu lực.

## Bước 3 — hợp đồng triển khai sau phản biện

CLAIM: missing/recovery/migration/import không thể cho phép giảm cách ly local
C/C++/Python. Readiness cần probe strict hiện tại đã hoàn tất; completion bị
invalidate không ghi đè probe mới. Chọn compiler cập nhật trạng thái tự động.
WHY: tái sử dụng compiler không được âm thầm đổi containment của bài học sinh;
người dùng không phải tự bấm Verify để làm mới trạng thái bình thường.

Phản biện fresh-context (read-only) có bốn finding valid + actionable: cache
completion cũ có thể ghi đè probe mới, UI chỉ fetch một lần sau chọn local path,
migration ghi đè legacy true làm mất thông báo, và đọc policy không có giới hạn
trước allocation. Người dùng chọn bỏ phản biện chéo; không gọi CLI bên ngoài.

Điều chỉnh migration: tạo strict false cho file thiếu bằng atomic writer hiện
có; giữ nguyên bytes của file tồn tại (kể cả legacy true/corrupt/future schema).
Loader trả effective false và recovery diagnostic cho legacy true. PUT/save true
bị từ chối, không ghi file. Đọc file bằng descriptor với tối đa4097 bytes, không
dùng whole-file read rồi mới kiểm tra độ dài. Chỉ probe mới còn sở hữu cache entry
được publish. Regression tests phải RED trước sửa logic.

Chia nhỏ kiểm chứng: 3A policy/admission/cache/migration/import/UI refresh, 3B
probe compiler + submission + checker và cancel/drain. Pascal/Scratch, content
identity/TOCTOU và Rust experimental admission không được coi là đã bảo vệ chỉ
bằng 3A; thuộc bước4/5. OSD vẫn hoãn. Chưa tuyên bố hoàn thành bước3.

### Checkpoint 3A / nghiên cứu 3B

3A đã implement: strict false cho missing/recovery/import; legacy true giữ nguyên
bytes và trả diagnostic; PUT true bị từ chối; đọc policy tối đa4097 bytes với
nonblocking flag khi hệ điều hành hỗ trợ. Cache completion cũ không publish sau
invalidate. Themis import chỉ cấu hình path, không thay policy. UI refresh/polling
tiếp tục sau chọn compiler, queued refresh không mất khi request trước thất bại,
và host failure không làm mất trạng thái pending đã đọc. Notice VI/EN không có
toggle giảm cách ly. Rust experimental API chỉ đồng bộ GET false/PUT true400,
không coi đây là hoàn thiện isolation/admission của backend Rust.

Focused RED/GREEN: policy10/10, cache6/6, migration10/10, routes11/11,
toolchain UI11/11, host refresh4/4, Rust HTTP server1/1. Hai lỗi refresh có test
RED thực tế riêng trước fix; no skip mới/no threshold hạ. Final check:fast PASS.
Full log artifacts/local-policy-3a-check-full-20261012.log kết thúc exit0:
Rust9/9, server882 tests / 872 PASS / 0 fail / 10 skips cũ, 126 test files,
corpus25 cases, parity67 fixtures bốn tầng, version1.5.5. Sau gate đủ30 inputs
và executable952320 bytes SHA-2569e7359984262f224e0864bcde0f66ce9b655f3870e077364c9a733d55129d41a
vẫn khớp receipt. Không tuyên bố native UX3A PASS: người dùng nhấn Escape và
Computer Use dừng ngay trước khi chọn cửa sổ; không có screenshot3A mới.

3B chỉ có thiết kế tại docs/reports/local-probe-roles-design-2026-10-12.md.
Fresh reviewer lần đầu lỗi capacity, retry thành công, tìm bốn finding actionable:
internal_error không chứng minh Job Object rỗng; cleanup uncertainty bị catch nuốt;
discovery signal không huỷ probe resolver đã chạy; clear cache tạo probe trùng.
Người dùng bỏ phản biện chéo. Đã bổ sung hợp đồng giữ workspace/operation khi
drain chưa xác nhận, operation-owned cancellation và tách cache khỏi ownership;
chưa sửa logic3B. Tiếp theo: tiếp tục desktop3A khi được phép Computer Use rồi
TDD3B ownership/drain và compiler+submission+checker. Bước4–6 chưa triển khai.

### Tiếp tục 2026-10-12/13 — native 3A và implementation 3B

Người dùng cấp lại Computer Use. Native 3A đã quan sát đủ light/dark × VI/EN ×
normal/narrow trên hai bản dev rebuild; automatic local selection pending ->
incompatible không cần Self-Test, không fallback. Manifest, build timestamps,
fixture, screenshot hashes và giới hạn UX tại
`../verification/frontend-redesign/local-policy-3a-native-20261012.md`.
Không đổi compiler preferences thật; dark/VI được khôi phục; hai app đóng bình
thường, sidecar/session exit0. Đây là scoped notice/refresh acceptance, không phải
full accessibility PASS hay positive compiler proof; macOS NOT_RUN.

3B đã thêm operation registry tách khỏi admission cache, owned abort controller,
join cancellation, shutdown sealing/drain và retained cleanup errors. Compiler
C/C++ phải sinh executable regular/nonempty <=8MiB rồi chạy submission và checker;
Python chạy cả hai isolated runtime roles. Before-submit abort chặn ordered write;
đợi run settlement và cancellation ack, không early Promise.race cleanup. Unknown
drain giữ workspace và operation, từ chối probe thay thế, làm shutdown thất bại.

Ba vòng doubt bounded đã xong: design có4 actionable; code review có1 actionable
(missing/unknown IPC reason không chứng minh drain); vòng cuối không tìm thêm lỗi
độ tin cậy cao. Người dùng bỏ cross-model cả ba vòng; không gọi CLI ngoài. Fix IPC
ở canonical Node boundary bảo vệ cả run và interactive submission/interactor;
shared reason list/type không thay native wire. TDD còn khóa cached readiness sau
shutdown, output rỗng/quá lớn; fixture Apple Clang dùng owned Xcode-layout giả,
không cần skip mới hay SDK thật trong deterministic test.

Focused GREEN: local-probe22/22, executor client30/30, local-execution ownership7/7.
RED logs giữ nguyên, gồm test import typo ban đầu được sửa trước behavioral RED.
Fast PASS tại `artifacts/local-probe-3b-check-fast-20261012.log`. Native inputs và
recipe không đổi; chưa commit/push/version bump/dependency/skip mới.

Native in-place gate CHƯA ĐẠT: MSYS2 GCC16.1 C/C++ trả0xC0000135; Python3.12.10
cài trong user Programs trả0xC0000022. Các package GCC/Python hiện có trong user
AppData khi chọn dưới dạng local cũng trả0xC0000022. Giữ full negative logs:
`artifacts/local-probe-native-first-20261012.log`,
`artifacts/local-probe-native-pack-layout-20261012.log`.
Theo [Microsoft NTSTATUS](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55),
hai mã lần lượt là DLL_NOT_FOUND và ACCESS_DENIED; chưa xác định DLL/object cụ thể.
Source Windows chỉ cấp ACL read/execute cho protected executor caches, không cấp
đọc cho external local root; đây là ranh giới cần điều tra, không được chữa bằng
resource-only, tự sửa ACL bản cài gốc, hay tự thay compiler. Gate copy-controlled
đang tách role pipeline khỏi quyền đọc đường dẫn gốc; PASS nếu có cũng không chứng
minh in-place compiler hoạt động. Chưa tuyên bố hoàn thành3B/bước3.

Full gate đầu CHƯA ĐẠT: Rust8/9, core engine TLE timeout trong thời gian máy Modern
Standby; server/parity/version chưa chạy ở lượt này. Kernel-Power ghi standby từ
15:12 tới gần16:06 ngày12, trùng khoảng gate. Focused TLE trên máy thức PASS2,30s,
không sửa test/timeout. Log `artifacts/local-probe-rust-tle-diagnostic-20261013.log`.
Full gate mới đang chạy: `artifacts/local-probe-3b-check-full-resumed-20261013.log`;
chưa ghi PASS trước khi kết thúc và đối chiếu receipt sau gate.

#### Harness/verification correction — 2026-10-13

Full retry đã qua Rust9/9 nhưng test:server build:executor bị EBUSY: probe đang
giữ staged executable lúc bước build copy lại nó. Không sửa packaging để che lỗi;
các native host probes và full gate phải tuần tự. Bản test executable sau này được
copy riêng vào fixture để không khóa staged binary.

Controlled-copy run đầu4/4 qua nhưng KHÔNG dùng làm bằng chứng owned-root:
JUDGEDESK_EXECUTOR_TEST_ROOT không được release binary đọc. Nó thực tế dùng cache
`C:/Users/mon/AppData/Local/JudgeDesk/JudgeDeskExecutor/toolchains/owned-local-gate-0`
và `owned-local-gate-1`. Hai thư mục mới do gate tạo đã được chuyển nguyên trạng,
sau shutdown exit0 và kiểm tra exact path/no-link, vào
`C:/Users/mon/AppData/Local/Temp/judgedesk-probe-recovery-15642d5890c24e7e8e73db0b85ccc254/`
để phục hồi/audit. Không di chuyển/xóa toolchain bản cài gốc hoặc các cache khác.
Không lấy log4/4 này làm bằng chứng fixture isolation.

Harness sửa process-scoped LOCALAPPDATA/APPDATA, copy riêng executor và assert
native health root nằm dưới mkdtemp trước mọi probe/copy. Dùng staging primitives
hiện có để kiểm tra regular files/size/count, không đổi user ACL hay sandbox.
Fast gate sau sửa PASS; owned-root native gate đang chạy lại. Bản gate này dành
Windows; macOS cần host fixture riêng, không thêm conditional skip.

Corrected owned-root native gate đã qua4/4, exit0; C/C++ compiler + generated
submission/checker, Python hai runtime roles. Corrected original-path gate vẫn
fail4/4, cùng ba executable trả ACCESS_DENIED. Cả hai gate xác nhận owned native
root và dọn fixture sau shutdown; không dùng PASS của bản copy để đóng in-place
acceptance. Hồ sơ: `local-probe-windows-read-access-2026-10-13.md`.
Final full gate đang chạy tuần tự ở
`artifacts/local-probe-3b-check-full-final-20261013.log`, Rust9/9 đã qua.

#### Final code gate closure — 2026-10-13

Lượt final tuần tự đã kết thúc exit0: check:fast PASS; Rust9/9;
test:server 912 tests / 902 PASS / 0 fail / 10 conditional skips có sẵn,
129 test files; live corpus25 cases; checker parity67 fixtures cả bốn tầng;
release:check-version xác nhận1.5.5. Log:
`artifacts/local-probe-3b-check-full-final-20261013.log`.
Sau khi gate kết thúc, cả30 raw inputs khớp receipt và staged executable vẫn có
952320 bytes, SHA-256
`9e7359984262f224e0864bcde0f66ce9b655f3870e077364c9a733d55129d41a`.
`git diff --check` PASS. Không thêm dependency, waiver/skip, version bump,
commit/push hoặc thay đổi native identity trong3B.

Đây là closure của code/regression gate, KHÔNG phải product acceptance toàn
bước3: corrected original-path native gate vẫn thất bại; chỉ corrected controlled
copy gate qua4/4. Người dùng không phải tự cấp quyền hoặc Verify để chữa lỗi này.
Tiếp theo cần thiết kế/reuse snapshot và certified-local deployment hiện có,
ràng buộc probe với đúng execution deployment thực tế, rồi kiểm thử quyền đọc,
mutation/TOCTOU và positive/negative kernel boundaries. Không chỉ probe bản copy
rồi chấm bằng path gốc. Bước4–6 chưa hoàn tất; OSD tiếp tục hoãn.
