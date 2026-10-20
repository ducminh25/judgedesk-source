# JudgeDesk hardening — tiến độ 2026-10-12

Phạm vi: triển khai tuần tự 6 bước đã được người dùng duyệt. Không triển khai OSD,
không commit/push/phát hành, không thêm dependency, không hạ CONSTRAINTS.md.

| Bước | Trạng thái | Điều kiện nghiệm thu |
|---|---|---|
| 1. Artifact/full gate | PASS (Windows x64 + macOS arm64) | Build sạch tái lập, frozen identity đúng, full gate và đối chiếu cuối PASS trên cả hai hệ điều hành |
| 2. CE và lỗi hạ tầng | PASS (Windows + macOS + Native UI Gate 4) | Provenance xuyên compiler/session/scoring/UI/export; syntax CE không đổi; Gate UI 4 PASS |
| 3. Local execution policy | PASS (Windows + macOS `quick_verified_direct` + Native UI Gate 2) | Default/recovery fail-closed; migration/import không tăng quyền; readiness trung thực; Gate UI 2 & macOS native probe PASS |
| 4. Sandbox từng ngôn ngữ | PASS (Windows AppContainer + macOS Seatbelt real toolchains) | Không resource-only cho untrusted code; positive/negative kernel tests từng vai trò trên cả Windows và macOS host thật |
| 5. Backend/API desktop | PASS (Windows + macOS + Native UI Gate 1 & Gate 3) | Không automatic experimental fallback; API phiên/Origin/Host/SSE, CSP và Startup/Retry UI (`Gate UI 1` & `Gate UI 3`) PASS |
| 6. Vòng đời và determinism | PASS (Windows + macOS Seatbelt/Guardian/Interactive 91-row matrix) | Cancel/error/shutdown drain hoàn toàn; terminal một lần; toàn bộ guardian/interactive gates trên macOS PASS |

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

#### Product-policy closure after the Windows read-access gate — 2026-10-13

The direct/copy evidence invalidated the advertised Windows
`quick_verified_direct` contract. The first production-safe correction does not
silently copy a detected installation, mutate its ACL, weaken AppContainer or
pretend that a copied probe authorizes the original path:

- Windows local C++ now uses the existing explicit `freeze_required` workflow.
  A current certificate resolves through one shared mapper to the immutable
  protected snapshot in both cached/UI state and the judge resolver. An absent,
  stale or drifted certificate remains unavailable with its exact diagnostic.
- Windows local C and Python are temporarily `managed_only`; their local source
  radios are unavailable instead of advertising a direct path that the native
  gate proved unreadable. Their future custom-toolchain support requires the
  same planned/confirmed protected deployment contract, not a broad ACL grant.
- macOS ARM64 keeps `quick_verified_direct`; this change makes no new macOS
  runtime claim. Production discovery schedules compatibility probes only for
  host/profile pairs whose registry mode is actually quick direct.
- Registry revision increased from 6 to 7, invalidating stale discovery state.
  API golden fixtures were updated only for the observed revision/policy/source
  availability changes.

UX effect on Windows: a selected C++ compiler is detected but cannot judge until
the user invokes **Freeze for contest** and accepts the existing file-count/size
plan. This is a one-time protected import, not a request to grant filesystem
permissions. C and Python custom paths are disabled for now; Core can install a
managed pack and Full can use its included/installed managed pack. JudgeDesk does
not silently switch a persisted local selection to managed.

TDD evidence: registry/helper tests failed first on the old quick policy and
missing shared certificate mapper, then passed. Focused resolver/certificate,
route/discovery/profile and React tests passed; `check:fast` passed. First
`test:server` run failed only the two expected API golden cases (revision/policy),
which were reconciled from the emitted structural diff. The second full server
run passed 913 tests / 903 pass / 0 fail / 10 existing conditional skips, with
30/30 API golden cases and the live corpus. No dependency, app version, native
source, frozen executor identity, test skip or quality threshold changed.

Desktop dev started the real Windows secure runner successfully in
`windows-lpac-job` mode with network, filesystem and process-tree proofs. Native
Computer Use APIs were unavailable in this session (`apps` empty and no native
window listing methods), so the button's live visual state was not claimed as
observed. Static React coverage for the freeze action passed; actual click/freeze
was intentionally not performed because it would create a roughly gigabyte-scale
snapshot in the user's live cache.

#### Product-policy final verification — 2026-10-13

The enclosing `npm run check:full` completed successfully and is recorded in
`artifacts/local-policy-product-closure-check-full-20261013.log`: `check:fast`
passed; the Rust aggregate passed 9/9; `test:server` completed 913 tests with
903 pass, 0 fail and the same 10 conditional skips; the Themis parity gate
passed 67/67 fixtures in each Node, Rust, compiled C++ and packaged-binary tier;
and `release:check-version` confirmed 1.5.5. The earlier focused set passed
51/51 after the shared host-policy and certificate-field refactor.

Post-gate identity verification recomputed every entry in
`executor-freeze-2026-10-12.json`: all 30/30 source inputs matched and the staged
executor remained 952320 bytes with SHA-256
`9e7359984262f224e0864bcde0f66ce9b655f3870e077364c9a733d55129d41a`.
`git diff --check` passed. The final diff contains no version/dependency or native
source change. A self-adversarial review consolidated host policy lookup in the
language registry and certificate-to-execution mapping in certificate readiness;
no external-model review was requested or used for this closure.

This verifies the safe policy correction, not universal custom-toolchain support:
Windows custom C++ still requires the explicit protected freeze, while custom C
and Python remain managed-only until the planned/confirmed protected deployment
workflow is generalized to those runtimes. No silent compiler fallback, ACL
mutation, AppContainer weakening, automatic gigabyte-scale copy, commit, push or
GitHub Actions run was introduced.

#### Step 4 sandbox matrix — interim evidence and blocking Windows finding — 2026-10-13

The first Step 4 slice replaced smoke-only claims with live prohibited-operation
gates. Pascal, C++ and C submissions now attempt private-home read, destructive
write and a connection to an open host loopback listener; each program handles
the OS denial, prints the expected normal output and receives AC. The protected
sentinel remains byte-identical and the listener accepts zero connections.
Pascal's obsolete `JUDGEDESK_PASCAL_ISOLATED` downgrade was removed from the
Node and Rust-core callers, rejected at the native IPC boundary, and no-grant
native artifacts remain strict LPAC. The truthful downloaded-package gates pass:

- Pascal smoke + boundary: 4/4 in
  `artifacts/step4-pascal-strict-green-20261013.log`.
- C++14/C11 smoke + boundary: 5/5 in
  `artifacts/step4-c-cpp-boundary-20261013.log`.
- Python handled-denial regression: PASS in
  `artifacts/step4-python-denial-green-20261013.log`.

Scratch no longer requests `resource-only` execution. Its verified package is
imported into the executor cache and launched with a typed managed grant; the
real Scratch smoke gate passes under strict regular AppContainer in
`artifacts/step4-scratch-managed-strict-green-20261013.log`.

That compatibility mode is not yet acceptable as zero-network isolation. A new
probe connected to an actually listening loopback endpoint while private-home
read/write were denied (`networkBlocked=false`), reproduced after extending the
probe to target the live port. Evidence:
`artifacts/step4-scratch-loopback-boundary-20261013.log`. This invalidates the
old closed-port/external-endpoint network tests for regular managed runtimes and
applies to the shared Windows compatibility boundary, not only Scratch. The
authoritative contract requires rejecting such runs until isolation is proven;
the Step 4 gate therefore intentionally remains RED. No skip, waiver, fallback,
dependency, version change, commit, push or GitHub Actions run was introduced.

The root architectural follow-up is a dedicated per-run AppContainer identity
with explicit workspace authority and read-only verified-runtime access, plus
open-listener zero-network and sibling-workspace tests. A short-term fail-closed
policy can disable Windows managed runtime roles while that work lands; retaining
the current regular compatibility boundary is not a valid option under
`guidelines.md` and `CONSTRAINTS.md`.

#### Step 4 Windows per-run identity closure — 2026-10-13

The previous paragraph's statement that the compatibility probe *connected* is
superseded by stronger instrumentation. The old `networkBlocked=false` field
meant only that `connect_timeout` did not return `PermissionDenied`; its assertion
failed before the test inspected the listening server, so it did not distinguish
a successful connection from a firewall timeout. The helper now reports
`networkConnected`, error kind and raw OS error separately, while the gate also
counts connections accepted by an actually open loopback listener.

Windows compiler, managed submission and checker-runtime launches now create a
unique AppContainer profile per run with zero capabilities. The profile SID owns
only that run's workspace. The verified toolchain cache is read/execute for the
well-known All Application Packages SID so a fresh identity can load certified
runtimes; the artifact cache retains the stable executor SID, and the workspace
parent grants traverse only, without list or inherited child access. Both normal
and interactive launch paths use the same boundary classifier. Explicit profile
deletion occurs only after the corresponding Job is drained; cleanup failure is
reported fail-closed. Resource-only remains disabled by product policy and is
not used by Scratch.

The direct release-binary IPC probe repeated the hostile boundary with an open
listener. Private read/write were denied, the sentinel stayed `PRIVATE`,
`networkConnected=false`, Windows returned `TimedOut`, and the listener accepted
zero connections. The same harness then launched an interactive managed
submission plus checker-runtime through two ephemeral profiles and received a
terminal AC. After normal, interactive, cancellation and compiler/runtime gates,
the registry contained zero `JudgeDesk.Run.*` profiles and no executor process
remained. Preserved evidence:

- `artifacts/step4-ephemeral-loopback-green-20261013.log`;
- `artifacts/step4-ephemeral-interactive-green-20261013.log`.

Regression and live-toolchain evidence after the change:

- native executor: 105 library + 5 binary tests, zero failures; strict Clippy
  and rustfmt pass;
- C++14/C11 downloaded packages: 5/5 including both private-file/open-loopback
  boundaries;
- Pascal/Java/Python downloaded packages: 8/8 including all three boundaries;
- Windows security suite without Python package: 14 pass, 5 expected skips,
  zero failures; the new Scratch boundary passes;
- focused real managed Python: 4/4 for submission, checker-runtime,
  handled-denial and cancel-after-terminal-drain.

This closes the Windows code/evidence blocker for the Step 4 roles exercised
above. It does not claim macOS runtime acceptance, performance optimization of
per-run profile creation, or the final repository-wide gate/frozen-executor
receipt; those remain separate verification work before Step 4 is declared
fully complete.

#### Step 4 Windows final freeze and gate — 2026-10-13

The final five-axis self-review found one remaining high-confidence teardown
gap: a single run that did not report an empty Job after the bounded wait was
classified as an internal error but could still return toward profile deletion
without a positive drain proof. The existing launch-rollback primitive was
generalized and is now used by duplicate-ID, resume-failure, normal teardown
and both interactive participants. It terminates the exact Job, waits on the
exact child handle, verifies zero active Job processes, and stops the executor
fail-closed if any of those proofs fail. Interactive forced teardown is a JE,
never an accepted result. The fault-injection test was RED before the generalized
primitive existed and GREEN afterward.

The post-review candidate was clean-built twice from the locked Windows recipe;
both builds produced exactly 964096 bytes with SHA-256
`fd2c06d8c0b9baaa24051c9044e4166904d7f43459899db54d3019dc69eb2b24`.
The compiled native-source fingerprint is
`b7ad2fc934a221085dab42fe0de7de49f13dd8a542cd29c62af68fd6fc4bc9bc`.
The literal Rust boundary pin and `executor-freeze-2026-10-12.json` bind that
candidate to the current HEAD plus all five dirty native inputs. The receipt
test passed 3/3 and recomputed all 30/30 raw inputs after the final gate.

Final verification on this Windows host:

- native executor 105 library + 5 binary tests PASS; Rust core packaged boundary
  27/27 PASS; native fmt and strict Clippy PASS;
- the complete Windows security suite passed 19/20 with one macOS-only skip,
  including concurrent managed workspace separation, open-listener network
  denial, Python submission/checker roles, 20-repetition timing and memory
  boundaries, process bomb, explicit cancellation and terminal drain;
- `npm run check:full` PASS after the final source/freeze change: 9/9 Rust gate
  steps; server 915 total / 905 pass / 0 fail / 10 registered conditional skips;
  checker parity 67/67 in Node, Rust, compiled C++ and packaged-Windows tiers;
  release version lockstep 1.5.5;
- final artifact hash/size still match the frozen receipt, `git diff --check`
  is clean, and the host has zero `JudgeDesk.Run.*` profiles and zero native
  executor processes left behind.

Step 4 is therefore PASS for the exercised Windows language/role matrix. It is
not a macOS acceptance claim: real Seatbelt/runtime execution remains NOT_RUN
until a macOS host is available. Per-run profile creation performance also has
not been benchmarked; correctness and isolation, rather than an unmeasured speed
claim, are the acceptance basis. No dependency, version, skip, fallback, commit,
push, release or GitHub Actions run was introduced.

## Bước 5 — Backend/API desktop (PASS code/full gate trên Windows; native UI NOT_OBSERVED)

Implementation ngày 2026-10-13/14 loại bỏ hai fallback ngầm: không còn cổng 3000
mặc định và Node sidecar không còn tự chuyển sang Rust backend thử nghiệm khi
sidecar thiếu hoặc spawn lỗi. Rust core chỉ được chọn bằng giá trị opt-in chính
xác `JUDGEDESK_PURE_RUST_CORE=1|true`; giá trị thiếu dùng Node, còn giá trị sai
fail rõ ràng. Lỗi tạo Tauri app hiển thị native startup dialog thay vì panic.

Tauri sinh token 256-bit riêng cho API session, giữ `port+token` trong state và
trả cả hai qua một IPC command. Node sidecar nhận token qua environment nhưng
entrypoint tiêu thụ/xóa nó trước startup gate/migration; Rust embedded nhận token
trực tiếp. Cả hai backend production buộc Host đúng `127.0.0.1:<port>`, Origin
thuộc allowlist nếu có, và header `X-JudgeDesk-Session` đúng cho mọi REST/SSE.
Preflight không mang token nhưng vẫn kiểm Host/Origin. Token được so sánh constant
time; response hợp lệ có CORS giới hạn, `no-store` và `nosniff`.

Frontend không còn raw API caller: `apiFetch` chèn/ghi đè session header cho mọi
request; OSD SSE chuyển từ `EventSource` không thể gắn header sang authenticated
fetch stream có parser chunk/CRLF và reconnect hữu hạn. Toolchain prewarm caller
bị audit phát hiện bỏ qua client chung đã được tái hiện RED rồi sửa. Regression
test quét toàn bộ source frontend để cấm `fetch("/api/...`)` và `EventSource` mới.
CSP Tauri nay giới hạn default/object/base/frame, chỉ cho IPC, HTTP backend
loopback cổng ngẫu nhiên và WebSocket Vite đúng cổng 5173.

UX startup không còn cửa sổ trắng khi IPC/session thất bại: giao diện VI/EN có
`role=alert`, giải thích không thiết lập được kênh bảo mật, nút Thử lại có focus
và trạng thái bận. Retry dùng lại quy trình session bắt buộc, không hạ xuống cổng,
token hay backend khác và không hiển thị token/exception kỹ thuật trên UI.

Evidence hiện có:

- focused Node/frontend/SSE/startup tests: 15/15 PASS;
- Rust middleware HTTP integration: missing token 401, bad Origin 403, valid
  token 200 + CORS, preflight 204;
- build/smoke contract suite: 19/19 PASS;
- SEA sidecar build PASS; executable thực từ chối thiếu startup token trước
  listen, chấp nhận startup token + API token, phục vụ status/workspace routes,
  rồi thoát code 70 và nhả port khi parent channel đóng;
- `npm run build:frontend` và `npm run check:fast` PASS;
- `npm run test:server` PASS: 930 total / 920 pass / 0 fail / 10 conditional
  skips đã đăng ký;
- final sequential `npm run check:full` PASS: Rust 9/9; server 930 total /
  920 pass / 0 fail / 10 conditional skips; parity 67/67 ở Node, Rust, compiled
  C++ và packaged-Windows; version lockstep 1.5.5;
- hậu gate: executor vẫn 964096 bytes, SHA-256
  `fd2c06d8c0b9baaa24051c9044e4166904d7f43459899db54d3019dc69eb2b24`
  và khớp receipt; `git diff --check` sạch; zero `JudgeDesk.Run.*` profile và
  không còn process JudgeDesk/server/executor do gate tạo ra.

Code gate của bước 5 đã PASS trên Windows. Nghiệm thu native vẫn tách riêng và
NOT_OBSERVED: cần `test:desktop` + Computer Use đã được người dùng cho phép để
quan sát app thực, xác minh CSP/session, trạng thái startup bình thường và màn
hình lỗi/retry light/dark VI/EN. macOS runtime vẫn NOT_RUN. Không dependency,
version, skip, fallback, commit, push, release hay GitHub Actions mới.

## Bước 6 — Vòng đời và determinism (PASS trên Windows; macOS runtime NOT_RUN)

Audit toàn bộ cancel/error/shutdown callers, terminal publishers và vòng đời
executor/server, kết hợp 3 vòng phản biện độc lập (`Step 6 Adversarial Reviewer`,
fresh-context `ARTIFACT + CONTRACT`), đã khóa đầy đủ các bất biến:

- **Executor IPC (`server/executor/client.ts`)**:
  - IPC request timeout terminalize generation hiện tại ngay lập tức: đóng
    admission, reject mọi pending request trong cùng generation bằng nguyên nhân
    đầu tiên, gửi `stdin.end()` đúng một lần để native executor cancel/drain,
    và giữ child/tree guard đến `close`.
  - Khi đang trong `stopChildForStartupRetry`, timeout của lệnh shutdown ở
    attempt 1 không được ghi đè `lifecycleState = "terminal"` hoặc `startPromise`
    của `start()`, đảm bảo attempt 2 khởi động lại thành công.
  - Callback `error`/`close` muộn và lệnh `shutdown()` gọi sau
    `terminalizeLiveChild` đều idempotent: giữ nguyên chẩn đoán terminal đầu tiên
    thay vì ghi đè bằng `Native executor exited (code=0, ...)` hay ghi vào
    `stdin` đã đóng.
- **Unified Server Drain & Job Cancellation (`server/routes/system-routes.ts`, `server/platform/server-lifecycle.ts`, `server.ts`, `server/jobs.ts`)**:
  - `/api/shutdown`, parent-channel loss (`startParentWatchdog`), và
    `SIGINT`/`SIGTERM` dùng chung quy trình `beginDrain -> cancelAllActiveJobs ->
    bounded lifecycle drain -> executor shutdown`; lỗi drain được truyền ra để
    process thoát fail-closed.
  - `ServerLifecycle.drain` chỉ chạy Phase 4 (`executorClient.shutdown()`) sau
    khi mọi phiên chấm (`activeJudgeSessionCount === 0`) đã thực sự kết thúc, với
    ngân sách timeout tối thiểu 2s cho bước đóng executor. Khi hết giờ chờ phiên
    chấm (`activeJudgeSessionCount > 0`), `drainPromise` được xóa để lần drain kế
    tiếp sau khi phiên chấm thoát vẫn tắt được executor; khi mọi phiên chấm đã
    thoát và cả 4 pha đã chạy xong, `drainPromise` được giữ memoized đúng hợp
    đồng idempotency. `prepareServerShutdown` bóc tách `AggregateError` từ
    `ServerLifecycle.drain()` để phân loại đúng `JUDGE_DRAIN_TIMEOUT` so với
    `SERVER_SHUTDOWN_FAILED`.
  - Mọi nhánh gọi `runReservedExecutor`/`runReservedInteractiveExecutor` có
    `jobId` (bao gồm `certified-local-session-probe.ts`, `compiler.ts`,
    `background-prewarm.ts`, `testcase-runner.ts`) đều đăng ký
    `attachExecutorRun(jobId, runId)` và dọn dẹp `detachExecutorRun(jobId, runId)`
    trong `finally`.
- **Judge Session & Stream Terminal Determinism (`server/judge/judge-event-writer.ts`, `server/judge/judge-session.ts`, `server/judge/certified-local-session-probe.ts`, `server/judge/testcase-runner.ts`)**:
  - `createJudgeEventWriter` chỉ phát tối đa một sự kiện kết thúc (`done` hoặc
    `error`), bỏ qua mọi sự kiện sau đó và gọi `res.end()` tối đa một lần.
  - Khi `jobId` bị hủy trong lúc prewarm, `ensureCertifiedLocalCppSessionProbe`,
    quét đề, biên dịch bài nộp, biên dịch checker/interactor hoặc chạy testcase
    (batch lẫn interactive), phiên chấm dừng ngay, không phát sự kiện
    `progress`/`problem_completed` muộn, không lưu kết quả biên dịch đã hủy vào
    cache `compiledCheckers`/`compiledCheckers`, không ném nhầm
    `TOOLCHAIN_PREFLIGHT_FAILED`, và `testcase-runner.ts` trả về kết quả hủy nhất
    quán (`status: "FAIL"`, `errorDetail: "cancelled"`).

Evidence nghiệm thu hoàn chỉnh (2026-10-14):

- Focused Step 6 suites (`server-lifecycle.test.ts`, `jobs.test.ts`,
  `executor/client.test.ts`, `judge-session-provenance.test.ts`,
  `judge-event-writer.test.ts`): **60/60 PASS** (tất cả phát hiện từ phản biện đều
  có test tái hiện `RED` trước khi sửa sang `GREEN`);
- `npm run check:fast` PASS (`tsc --noEmit` + `check-quality-gate.js`);
- Sequential `npm run check:full` PASS hoàn toàn (exit code `0`):
  - `test:rust`: **9/9 PASS** (`native-executor`, `crates/judgedesk-core`,
    `src-tauri` — `fmt`, `clippy`, `test`);
  - `test:server`: **943 total / 933 pass / 0 fail / 10 conditional skips** Across
    43 suites;
  - `test:themis-parity`: **4/4 tiers PASS** (67/67 fixtures ở Node, Rust,
    compiled C++ và packaged Windows binaries `C1.exe`–`C5.exe`);
  - `release:check-version`: **PASS** (`1.5.5` đồng bộ trên cả 8 file);
- Hậu gate hygiene:
  - Frozen executor `native-executor/target/x86_64-pc-windows-msvc/release/judgedesk-native-executor.exe`
    (và bản staged `src-tauri/binaries/judgedesk-executor-x86_64-pc-windows-msvc.exe`)
    giữ nguyên kích thước `964096` bytes, SHA-256
    `fd2c06d8c0b9baaa24051c9044e4166904d7f43459899db54d3019dc69eb2b24` và `0`
    input mismatch so với `docs/reports/executor-freeze-2026-10-12.json`;
  - `0` thư mục `JudgeDesk.Run.*` còn sót;
  - `git diff --check` sạch (exit code `0`);
  - Mọi tiến trình kiểm thử và subagent đã được đóng an toàn.
- Nghiệm thu Native Desktop UI qua Computer Use (`docs/reports/judgedesk-native-ui-acceptance-2026-10-14.md` & `artifacts/native-ui-acceptance-2026-10-14/screenshots.md`):
  - **Gate UI 3 (Step 5 Startup Failure / Retry UI)**: **PASS** trên toàn bộ ma trận 8 tổ hợp (`Light/Dark × VI/EN × Normal 1536×792 / Narrow 960×600`).
  - **Gate UI 1 (Step 5 Normal Session / CSP)** & **Gate UI 2 (Step 3 `F6` Toolchain Manager)**: Reviewer (Codex Computer Use) ghi nhận `PARTIAL` với 6 điểm cần khắc phục; toàn bộ 6 điểm đã được xử lý dứt điểm bằng TDD (`RED` → `GREEN`) và build lại đồng bộ (`dist/`, `dist/server.cjs`, `src-tauri/binaries/server-x86_64-pc-windows-msvc.exe`, `src-tauri/target/debug/judgedesk.exe`):
    1. **Menu trạng thái trên toolbar đè lên modal `F6` (`src/components/AppToolbar.tsx`, `src/features/toolchains/ToolchainManager.tsx`)**: tự động đóng `utilityMenuOpen`/`brandMenuOpen` khi nhấn phím tắt hàm (`F1`–`F12`) hoặc tổ hợp `Ctrl`/`Meta`, nâng lớp phủ `ToolchainManager` lên `z-[100]` (cao hơn `z-[80]`/`z-[90]` của menu), và gắn `data-toolchain-menu-trigger="true"` để trả focus về nút công cụ khi đóng modal.
    2. **Thông báo policy local và chú thích radio `managed_only`/`freeze_required` (`src/locales/vi.json`, `src/locales/en.json`, `src/features/toolchains/ToolchainManager.tsx`)**: cập nhật chuỗi `localPolicyLegacyDisabled` và `localPolicyRecovery` khớp chính sách cô lập nghiêm ngặt hiện tại; hiển thị trực tiếp giải thích `toolchains.registry.localExecution.<mode>` ngay dưới nhóm radio trong cột `Nguồn bộ công cụ` / `Compiler/runtime source` khi profile ở chế độ `managed_only`, `unsupported`, hoặc `freeze_required`.
    3. **Nhãn trạng thái tiếng Việt `not_available` gây hiểu nhầm (`src/locales/vi.json`)**: đổi `toolchains.registry.statuses.not_available` từ `"Không tìm thấy"` sang `"Chưa khả dụng"` để tương ứng với `"Not available"` và không mâu thuẫn khi trình biên dịch cục bộ đã được phát hiện nhưng chờ chứng nhận (`CERTIFICATION_REQUIRED`).
    4. **Semantics hộp thoại và khóa/trả focus bàn phím cho modal `F6` (`src/features/toolchains/ToolchainManager.tsx`)**: bổ sung `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, đưa focus ban đầu vào nút đóng khi mở modal, giữ vòng lặp `Tab` / `Shift+Tab` bên trong modal, bổ sung `focus-visible:outline-2`, và hoàn trả focus về phần tử gọi khi đóng.
    5. **Chớp lỗi tạm thời `Failed to fetch` khi mở lại `F6` (`src/features/toolchains/useToolchains.ts`, `src/features/toolchains/ToolchainManager.tsx`)**: thêm tùy chọn `suppressError` trong `fetchState` khi `retriesRemaining > 0` ở `loadInitialState` và trong vòng lặp `poll` nền; ánh xạ thông báo `"Failed to fetch"` sang chuỗi đa ngữ `t("toolchains.loadError")` nếu hết lượt thử.
    6. **Tắc nghẽn drain khi đóng cửa sổ ngay sau lúc khởi động (`server/judge/background-prewarm.ts`)**: bổ sung kiểm tra `isClosing()` (`serverLifecycle.isClosing`) trước và sau từng pha bất đồng bộ trong `executeJudgePrewarm` (đặc biệt ngay sau `waitDiscovery()` khi `cancelToolchainDiscovery()` vừa giải phóng promise), trả về `{ status: "deferred", reason: "SERVER_CLOSING" }` tức thì thay vì khởi chạy biên dịch PCH trong lúc server đang tắt.
  - **Focused Delta Re-verify 1–3 (`docs/reports/judgedesk-native-ui-acceptance-2026-10-14.md` §5–§7 & `artifacts/native-ui-acceptance-2026-10-14/screenshots.md` #80–#121)**:
    - Sau khi khóa thêm bẫy focus bàn phím của `SubmissionDetailModal` (`role="dialog"`, `aria-modal="true"`, focus vào nút đóng khi mở, vòng lặp `Tab`/`Shift+Tab` nội bộ, trả focus về ô bảng điểm khi đóng bằng `Escape` hoặc nút đóng) và căn chỉnh chiều cao/nhãn dải bộ lọc verdict ở `960×600`, đợt kiểm chứng độc lập cuối cùng (`Focused Delta Re-verify 3`, ảnh `#104`–`#121`) xác nhận toàn bộ **4/4 cổng giao diện native trên Windows đều `PASS`**:
      - **Gate UI 1 (Step 5 Normal Session / CSP / Lifecycle)**: **PASS**
      - **Gate UI 2 (Step 3 `F6` Toolchain Manager)**: **PASS**
      - **Gate UI 3 (Step 5 Startup Failure / Retry UI)**: **PASS**
      - **Gate UI 4 (Step 2 `CE` / `JE` Narrow `960×600` & Focus Trap)**: **PASS**

## Nghiệm thu Runtime & Phản biện thực chiến trên macOS Apple Silicon (`judgedesk-mac`, 2026-10-14)

Môi trường kiểm chứng: máy Mac thực `judgedesk-mac` qua Tailscale SSH (`macOS 26.6.2`, `Darwin 25.6.0 arm64`, Apple Clang `17.0.0`, Rust `1.94.1`, Node `24.19.0`).

### Các lỗi thực tế phát hiện qua phản biện và đã xử lý bằng TDD (`RED` → `GREEN`)

1. **Vượt ngưỡng 128 biến môi trường của giao thức executor trong test lifecycle macOS (`server/executor-tests/macos-interactive-lifecycle.integration.test.ts`)**:
   - Hàm `env()` trong test truyền nguyên `process.env` của shell macOS (>128 biến) vào `RunSpec.environment`, bị `native-executor/src/request_validation.rs` (`MAX_ENVIRONMENT_ENTRIES = 128`) từ chối. Đã thu gọn `env()` chỉ giữ các biến thực thi cần thiết (`PATH`, `TMPDIR`, `TMP`, `TEMP`, `HOME`, `LANG`, `LC_ALL`, `USER`, `LOGNAME`, `SHELL`, `SYSTEMROOT`) tương tự `buildCompilerEnvironment`.
2. **Đường dẫn `executorRoot` qua symlink `/var/folders` trên macOS trong `findLocalToolchainSnapshot` (`server/toolchains/snapshot.ts`)**:
   - `createLocalToolchainSnapshot` và `verifyLocalToolchainSnapshot` đều canonicalize `executorRoot` bằng `realpath`, nhưng `findLocalToolchainSnapshot` dùng trực tiếp `rawExecutorRoot` chưa qua `fs.realpathSync`. Trên macOS (`os.tmpdir()` nằm dưới symlink `/var/folders/... -> /private/var/folders/...`), `path.relative(executorRoot, canonicalExecutable)` sinh ra `../../../../../../../private/var/folders/...` làm `certificate-readiness.test.ts` thất bại. Đã sửa `findLocalToolchainSnapshot` gọi `fs.realpathSync(rawExecutorRoot)` trước khi tính `executableId`; cả `snapshot.test.ts` và `certificate-readiness.test.ts` đều `PASS` trên macOS và Windows.
3. **Wrapper stub `bin/python3.x` của macOS Framework Python gọi `posix_spawn` bị Seatbelt chặn trong Step 3 `quick_verified_direct` (`server/toolchains/local-execution.ts`, `server/toolchains/local-execution.test.ts`)**:
   - Khi chạy probe thực tế (`server/toolchains/local-probe.native-gate.ts`) trên `judgedesk-mac` với CommandLineTools Python (`Python3.framework/Versions/3.9/bin/python3.9`) và Homebrew Python (`Python.framework/Versions/3.14/bin/python3.14`), `cpp` và `c` (`clang++`/`clang`) `PASS`, nhưng `python` thất bại ở bước submission runtime probe.
   - Nguyên nhân gốc: trong các bản build framework của CPython trên macOS, `bin/python3.x` là wrapper `Mac/Tools/pythonw.c` gọi `posix_spawn(..., POSIX_SPAWN_SETEXEC)` sang `../Resources/Python.app/Contents/MacOS/Python`. Seatbelt profile của `Submission` và `CheckerRuntime` cấm `SYS_posix_spawn` và chỉ cấp quyền `process-exec` cho đúng literal executable đã đăng ký. Trong khi đó, `Resources/Python.app/Contents/MacOS/Python` bên trong cùng `Versions/X.Y` là binary interpreter trực tiếp (`_Py_BytesMain`), không gọi `posix_spawn`.
   - Đã cập nhật `deriveLocalToolchain` và `inferLocalToolchainRoot` trên `darwin` cho `kind === "python"`: nếu `<canonicalRoot>/Resources/Python.app/Contents/MacOS/Python` tồn tại là regular file (không phải symlink) bên trong framework root `Versions/X.Y`, tự động ánh xạ `canonicalExecutable` về binary interpreter trực tiếp đó trong khi giữ nguyên `canonicalRoot` (`.../Versions/X.Y`) làm `rootPath` và `PYTHONHOME`. Probe thực tế `local-probe.native-gate.ts` lập tức `PASS 4/4` cho cả CommandLineTools Python 3.9 và Homebrew Python 3.14.5.
4. **Giả định `resolveManagedToolchain` trên Windows trong cổng Step 4 `c-submission.gate.test.ts` (`server/judge/c-submission.gate.test.ts`, `docs/verification/pure-rust-core/expected-skips.json`)**:
   - Trên `darwin`, C++14 và C11 sử dụng trình biên dịch Apple Clang tại chỗ qua `verifyLocalToolchainCandidate` (`provenance: "platform-certified"`) kết hợp `scheduleLocalCompatibilityProbe` thay vì gói `resolveManagedToolchain` (`packageOrigin`) như trên Windows. Đã cập nhật `c-submission.gate.test.ts` để hỗ trợ đúng nhánh `darwin` và cập nhật `sourceFingerprint` tương ứng trong `expected-skips.json`.
5. **Phân biệt hủy job người dùng (`verdict === "CANCELLED"`) với dọn dẹp tiến trình đối tác (`peer cleanup`) trong interactive mode trên macOS (`server/judge/testcase-runner.ts`, `server/judge/judge-session-provenance.test.ts`)**:
   - Khi chạy ma trận 91 hàng `macos-interactive-production.integration.test.ts` trên `judgedesk-mac`, phát hiện các hàng `submission wall timeout (TLE)`, `submission memory limit (MLE)`, `submission output/write/files quota (OLE)` và `checker output/write/files quota (JE)` trả về `FAIL / cancelled`.
   - Nguyên nhân gốc: trên macOS (`native-executor/src/macos_interactive.rs`), khi một tiến trình trong cặp interactive kết thúc do chạm ngưỡng (`wall_time_limit`, `memory_limit`, `output_limit`, `write_limit`), supervisor chủ động dọn dẹp tiến trình đối tác còn lại với `CleanupCause::Cancelled` (khiến tiến trình đối tác có `reason: "cancelled"`), trong khi `result.verdict` của cặp được giữ đúng là `"TLE"`, `"MLE"`, `"OLE"` hoặc `"JE"` (còn khi người dùng hủy job thật sự, `pair.user_cancelled()` là `true` và `result.verdict === "CANCELLED"`). Nhánh kiểm tra trong `executeInteractiveTestCase` trước đó kiểm tra `submissionResult?.reason === "cancelled" || interactorResult?.reason === "cancelled"` nên đã ghi đè nhầm `result.verdict`.
   - Đã sửa `executeInteractiveTestCase` chỉ trả về `FAIL / cancelled` khi `result.verdict === "CANCELLED"`, hoặc cả hai tiến trình đều `"cancelled"`, hoặc `activeJobs.get(options.jobId)?.cancel` đang bật; đồng thời bổ sung unit test hồi quy trong `judge-session-provenance.test.ts` và cập nhật `macos-interactive-production.worker.ts` khớp hợp đồng Step 2/3/4.

### Bằng chứng thực thi toàn bộ cổng macOS (`judgedesk-mac`)

- **`npm run check:fast` (macOS)**: **PASS** (`tsc --noEmit` + `check-quality-gate.js`, `0` vi phạm).
- **`npm run test:rust` (macOS, 9/9 bước)**: **PASS**
  - `native-executor`: `cargo fmt --check` PASS, `cargo clippy --all-targets -- -D warnings` PASS, `cargo test --locked` **78/78 PASS** (`66` unit + `5` binary + `7` protocol integration).
  - `crates/judgedesk-core`: `cargo fmt --check` PASS, `cargo clippy --all-targets -- -D warnings` PASS, `cargo test --locked` **54/54 PASS**.
  - `src-tauri`: `cargo fmt --check` PASS, `cargo clippy --all-targets -- -D warnings` PASS, `cargo test --locked` **21/21 PASS** (`17` unit + `4` binary).
- **`npm run test:server` (macOS, Node 24.19.0)**: **PASS**
  - Batch 1: **930 tests, 48 suites, 923 pass, 0 fail, 7 skipped** (kèm `25/25` live WP-03 corpus cases).
  - Batch 2: **953 tests, 43 suites, 945 pass, 0 fail, 8 skipped**.
  - Tổng cộng: **1.883 tests, 1.868 PASS, 0 FAIL, 15 registered conditional skips**.
- **`npm run test:themis-parity` (macOS)**: **PASS** (`67/67` fixtures khớp tuyệt đối trên Node, Rust và compiled C++ `C1`–`C5`).
- **`npm run release:check-version` (macOS)**: **PASS** (`1.5.5` đồng bộ trên cả 8 file).
- **Step 3 Native Compatibility Probe Gate (`server/toolchains/local-probe.native-gate.ts`) trên macOS**:
  - Apple Clang (`cpp`, `c`) + CommandLineTools Python 3.9: **4/4 PASS (`0 fail`)**.
  - Apple Clang (`cpp`, `c`) + Homebrew Python 3.14.5: **4/4 PASS (`0 fail`)**.
- **Step 4 Unskipped Real Toolchain & Seatbelt Boundary Gates (`JUDGEDESK_REAL_TOOLCHAIN_GATES=1`) trên macOS**:
  - `server/executor-tests/security.integration.test.ts`: **17/17 PASS (`0 fail, 0 skipped`)**.
  - `server/judge/c-submission.gate.test.ts`: **5/5 PASS (`0 fail, 0 skipped`)** (`cpp`, `c`, cùng kiểm thử chặn đọc file riêng tư và chặn loopback network cho cả `cpp` và `c`).
  - `server/judge/multi-language.gate.test.ts` (`JUDGEDESK_REAL_LANGUAGE_GATES="pascal,java,python,scratch"`): **9/9 PASS (`0 fail, 0 skipped`)** (`pascal`, `java`, `python`, `scratch`, cùng kiểm thử chặn đọc file riêng tư và chặn loopback network trong Seatbelt).
  - `server/judge/custom-checker.gate.test.ts`: **1/1 PASS (`0 fail, 0 skipped`)** (custom checker C++ và Python biên dịch, chấm điểm và giữ nguyên ranh giới cô lập Seatbelt).
- **Step 6 macOS Run Guardian & Interactive Seatbelt Suites trên macOS**:
  - `server/executor-tests/macos-run-guardian.integration.test.ts` (`JUDGEDESK_RUN_GUARDIAN_FAULT_GATE=1`): **5/5 PASS**.
  - `server/executor-tests/macos-interactive-admission.integration.test.ts`: **19/19 PASS**.
  - `server/executor-tests/macos-interactive-preparation.integration.test.ts`: **4/4 PASS**.
  - `server/executor-tests/macos-interactive-lifecycle.integration.test.ts`: **24/24 PASS**.
  - `server/executor-tests/macos-interactive-security.integration.test.ts`: **25/25 PASS**.
  - `server/executor-tests/macos-interactive-production.integration.test.ts` (`JUDGEDESK_INTERACTIVE_PRODUCTION_GATE=1`, full 91-row matrix): **1/1 PASS (`completedRows: 91`, `0 fail`, `90,63s`)** — xác nhận đầy đủ 6 ngôn ngữ phát hành (`cpp`, `c`, `python`, `pascal`, `java`, `scratch`) với interactor C++ và Python, strict local Python submission/interactor, toàn bộ 28 hàng verdict/award (`AC`, `WA`, `PE`, `PARTIAL` rational, `JE`, `RE`, `TLE`, `MLE`, `OLE`), các nhánh từ chối fail-closed, và chứng minh dọn sạch mọi process group/guardian/Seatbelt profile sau từng hàng.
- **Vệ sinh hậu kiểm (`Post-Gate Hygiene`) trên cả hai máy**:
  - Trên `judgedesk-mac`: đã dọn sạch thư mục tạm `/private/tmp/judgedesk-prod-gate-20261014`, `0` tiến trình `judgedesk-native-executor` / `judgedesk-executor-aarch64-apple-darwin` còn sót, `npm run check:fast` PASS.
  - Trên Windows: `npm run check:fast` PASS; `git diff --check` trên toàn bộ các file chỉnh sửa trong phiên sạch (`0` lỗi); frozen executor `src-tauri/binaries/judgedesk-executor-x86_64-pc-windows-msvc.exe` giữ nguyên kích thước `964096` bytes và SHA-256 `fd2c06d8c0b9baaa24051c9044e4166904d7f43459899db54d3019dc69eb2b24`.
