# Phân tích Themis và đối chiếu JudgeDesk

Ngày đánh giá: 11/10/2026. Phạm vi: bộ cài tại `C:\Themis`, báo cáo Themis do người dùng cung cấp, và mã nguồn JudgeDesk tại `D:\Minh\Code\judgedesk`.

JudgeDesk được đối chiếu ở commit `e83d63b427ac3d85da899e8bc8eaa082259fcbcb`, phiên bản 1.5.5. `guidelines.md` đã có thay đổi chưa commit trước cuộc đánh giá; thay đổi đó được giữ nguyên. Cuộc đánh giá tạo tài liệu và chứng cứ, không sửa mã ứng dụng.

## 1. Nhận định chính

JudgeDesk có nền tảng tốt để trở thành một hệ thống chấm đa nền tảng, có thể kiểm chứng và an toàn hơn mẫu Themis được cung cấp. Những lợi thế thực chất là sandbox OS theo từng lần chạy, kiểm soát cây tiến trình, checker ngoài được giới hạn tài nguyên, điểm phân số ở luồng Node/React, công cụ dịch có nguồn gốc và cơ chế xác minh, cùng bộ test tự động.

Tuy nhiên, mã hiện tại chưa bảo đảm các lợi thế đó cho mọi đường thực thi. Có nhiều đường chủ động chuyển sang `resource-only`; ở Windows chế độ này bỏ AppContainer, ở macOS nó dùng Seatbelt với `(allow default)`. Pascal, Scratch, một số toolchain local và fallback lỗi Windows 623 đều liên quan. Backend Rust thay thế cũng chưa tương đương backend Node: có endpoint trả thành công mà chưa thực hiện nghiệp vụ, compiler được gọi trực tiếp từ PATH và điểm checker đi qua `f64`.

Vì thế, ưu tiên đầu tiên nên là làm cho lời cam kết bảo mật, trạng thái readiness và hành vi thật thống nhất. Bổ sung tính năng hoặc thay toàn bộ UI trước khi giải quyết các đường này sẽ tăng phạm vi cần bảo vệ.

Themis vẫn có những điểm đáng học: mô hình thư mục dễ hiểu, thao tác chấm gọn, tương thích nhiều kỳ thi cũ, nhiều file I/O, bài nộp ZIP nhiều file, C6/AMM2 và C7. Không nên chuyển nguyên cơ chế tài khoản/mật khẩu và DLL chạy trong tiến trình chính sang JudgeDesk.

## 2. Phương pháp và giới hạn chứng cứ

Phân tích dùng skill REA để kiểm tra artifact Themis; dùng đọc mã nguồn, threat modeling và review chất lượng để đánh giá JudgeDesk. Ba mức chứng cứ được phân biệt:

- **Quan sát:** byte/metadata của file, tài nguyên PE, tên API, xref, mã nguồn, kết quả test đã chạy.
- **Suy luận:** hệ quả của một nhánh mã hoặc thiết kế; được nêu cùng điều kiện xảy ra.
- **Chưa xác minh:** điều cần chạy Themis, trace API động, fuzz parser hoặc kiểm thử trên macOS/bản đóng gói thật để kết luận.

Không chạy bài nộp độc hại qua Themis trên dữ liệu thật. Không coi import một API là bằng chứng rằng API đó được dùng đúng ở tất cả lần chấm. Không coi pseudocode Ghidra/IDR là mã nguồn Pascal gốc. Không dùng tuổi framework hoặc tên ngôn ngữ để tự suy ra chất lượng sản phẩm.

Các kết luận về Themis áp dụng cho **mẫu file trong `C:\Themis`**, không tự động áp dụng cho mọi bản Themis hay bộ cài chính thức khác. Các kết luận JudgeDesk chủ yếu dựa trên source hiện tại và các gate đã chạy, không phải chứng nhận an toàn của mọi installer đang phát hành.

### 2.1. Định danh Themis

| Thuộc tính | Quan sát |
|---|---|
| File | `C:\Themis\Themis.exe` |
| SHA-256 | `c044f8258e65b35130a283dd97df2e40211f86f32ce9ba94eeeb0a4f2f8905b7` |
| Kích thước | 7.074.304 byte, khoảng 6,75 MiB |
| Phiên bản file | 1.9.8.2806 |
| Kiến trúc | PE32, Machine 0x014c, x86 |
| CLR/.NET metadata | Không có CLI directory; mẫu là native PE |
| Tài nguyên | 147 resource, 9 form VCL, 10 VCL style |
| Chữ ký Authenticode | `NotSigned` đối với Themis.exe và 7 DLL judger đã kiểm tra |
| PE DllCharacteristics | `0x0000` đối với Themis.exe và 7 DLL judger |

`0x0000` có nghĩa header không khai báo opt-in DYNAMIC_BASE/ASLR, NX_COMPAT và GUARD_CF. Đây là quan sát tĩnh; chính sách Exploit Protection của Windows có thể áp đặt bảo vệ khác. Không được diễn giải thành bằng chứng rằng mọi mitigation đều tắt lúc chạy. File có `.reloc` cũng không đồng nghĩa tự động bật ASLR.

Timestamp 2019 trong PE header của báo cáo cũ chỉ là metadata có thể thay đổi. Nó không chứng minh toàn bộ bộ cài/toolchain trong thư mục có cùng tuổi hoặc cùng nguồn phát hành.

### 2.2. Chứng cứ REA mới

| ID | Nội dung | Giới hạn |
|---|---|---|
| `ev_c58570e40a7c41c60a1339ffcec5e0c3dd38274b9914e7775ba1ef689c4a0dc3` | Resource PE: identity, 147 resource, tên forms/styles | Payload form/style được ghi nhận; inventory không chứng minh runtime đã nạp chúng |
| `ev_1caff09120616518e3e60609dd46aa308abf6f97b0f689c781e1b75754a65b1d` | Native PE32 x86, không có CLR metadata | Không chạy hay phản chiếu assembly |
| `ev_4d4592342c642a98240af7b73e0ca836f3a121af95dd3ac4ed0a469c3556c6a5` | Overview Ghidra 12.1.4: 11.838 procedure, 9.117 string, 12 vùng ánh xạ | Procedure/string là inventory của auto-analysis, không phải số hàm nghiệp vụ hay độ bao phủ bảo mật |
| `ev_7d5538406f78af3f3be4d95563585a9e6a9753c30a9b8d1a61c34e5933888f54` | Tìm procedure JobObject: Create/Assign/Set/Query và thunk tương ứng | Import/tên procedure chứng minh liên kết; cấu hình limit cụ thể cần trace caller |
| `ev_b1d636ab53dbbbc8988cc6b4342b071d7e4d90b92f9b4b36242780bfdabad564` | Xref tới thunk SetInformationJobObject tại `0x6b6de8`: `0x6b7691`, `0x6b78b6` | Danh sách xref không tự giải mã cấu trúc limit hoặc chứng minh kết quả khi chạy |
| `ev_8ad5282e46a329cd8e50d95c3bbebd81392f268d3b2e6c8eb11f71e853c630ca` | Function `0x6b7614`: CreateJobObjectW, đặt UI restriction `0x80`, sửa bit `0x2000` rồi gọi wrapper limit | Decompiler không khôi phục đầy đủ type/local; không chứng minh đường này được gọi trong mọi lần chấm |
| `ev_5ca35e657b090e16c857fd4746f2d88d7b6a761578eadcd5572d4ae8f3cca016` | Wrapper `0x6b7894`: SetInformationJobObject với ExtendedLimitInformation và buffer 0x70 byte, xử lý khi API trả false | Xác nhận cấu trúc extended limit của caller; CPU/RAM từng role vẫn chưa được trace |

Ba Evidence ID trong báo cáo cũ không còn bản ghi tương ứng trong ledger REA của phiên này. Vì vậy đã tạo chứng cứ mới, thay vì chỉ trích lại ID cũ. Ghidra của MCP chưa có biến môi trường cấu hình; phân tích sâu dùng REA CLI với `GHIDRA_INSTALL_DIR` chỉ đặt cho tiến trình phân tích. Không thay cấu hình hệ thống và không cài dependency mới.

Chứng cứ được giữ lại tại [REA bundle](D:/Minh/Code/judgedesk/docs/reports/themis-rea-evidence-2026-10-11.json) (resource và native/managed classification) và [Ghidra snapshot](D:/Minh/Code/judgedesk/docs/reports/themis-ghidra-snapshot-2026-10-11.json) (search, xref và hai function dossier). Snapshot giữ kết quả Evidence, **không** phải database Ghidra hay source gốc. Overview có ID và số liệu ở bảng trên nhưng không có full envelope trong hai artifact này.

### 2.3. Các ranh giới cần bảo vệ

| Dữ liệu/đối tượng không tin cậy | Tài sản cần bảo vệ | Contract cần kiểm chứng |
|---|---|---|
| Source thí sinh và dữ liệu Scratch | Đề/test bí mật, file giáo viên, mạng, cây process | Cách ly cả compiler lẫn program/runtime; quota và cleanup; không tự hạ sandbox |
| Checker ngoài, interactor, plugin | Tiến trình điều khiển, công bằng verdict/điểm | Chạy ngoài app, theo role có quota/cách ly; crash là JE, không mặc nhiên WA |
| ZIP kỳ thi/bài nộp và path từ cấu hình | File hệ thống, dữ liệu kỳ thi khác, dung lượng đĩa | Validate path và byte giải nén thật; không follow link/đè file ngoài vùng sở hữu |
| File OSD và nộp lại | Identity bài, thứ tự/latest policy, log và kết quả | Snapshot bất biến; ingestion sau producer commit; job/hash thống nhất |
| HTTP caller và nội dung WebView | Chấm, sửa policy/toolchain, export và shutdown | Authorization từng request; không đồng nhất loopback/CORS với quyền người dùng |
| Gói toolchain/update và cache | Executable identity, compiler/runtime được chọn | Xác minh chữ ký/hash/provenance; atomic install; không tự đổi compiler khi lỗi |

Các boundary này độc lập: gói compiler được ký đúng không làm bài thí sinh đáng tin; Job resource limits không thay quyền file/mạng; app offline không đồng nghĩa không thể bị process local tác động.

## 3. Các công nghệ trong Themis

### 3.1. Native Delphi/VCL và tài nguyên giao diện

Themis là ứng dụng Windows native, không phải Electron hay ứng dụng CLR. Tài liệu đi kèm ghi **Delphi XE10 Seattle/RAD Studio XE10 Seattle**. Tên forms và VCLSTYLE trong PE phù hợp với mô hình VCL: giao diện được biên dịch và nhúng cùng chương trình.

Chín form được quan sát gồm `TMAINFORM`, `TJUDGEFORM`, `TEXAMEDITFORM`, `TFORMCPLCFG`, `TSECURITYFORM`, `TSETTINGSFORM`, `TREPORTFORM`, `TPROGRESSDLG`, `TABOUTFORM`. Mười style gồm các biến thể sáng/tối như CharcoalDarkSlate, TabletDark, TabletLight, Sky và Luna. Như vậy, nói Themis hoàn toàn không có theme là không đúng.

Ứng dụng chính nhỏ và dùng control native là một lợi thế triển khai. Tuy nhiên, kích thước 6,75 MiB không bao gồm các compiler, interpreter/JVM và toàn bộ dữ liệu kỳ thi. Không thể so con số này trực tiếp với kích thước installer Full của JudgeDesk.

Tên Graphics32 hoặc các class kiểu `TJudgeThread` trong báo cáo cũ là đầu mối hợp lý để khảo sát. Script tìm class bằng regex trên byte không đủ để chứng minh toàn bộ RTTI, sơ đồ lớp, thuật toán đa luồng hay số luồng chấm song song. Một worker thread giữ UI responsive cũng khác nhiều bài nộp được thực thi đồng thời.

### 3.2. Mô hình kỳ thi bằng thư mục và cấu hình

Themis dùng cấu trúc đơn giản: thư mục đề chứa các bài, mỗi bài chứa các thư mục test; thư mục bài làm chứa từng thí sinh; bài nộp tên `TênBài.*`. Với bài nhiều file, tài liệu cho phép `TênBài.zip`.

Mỗi bài có cấu hình và từng test có thể có điểm, thời gian, bộ nhớ riêng. Themis cho phép **danh sách nhiều file input và output**, phân cách bằng `|`; stdin và stdout được bật riêng và gắn với file đầu tiên trong danh sách. Tài liệu cũng cho phép để trống danh sách input khi bài không cần dữ liệu đầu vào.

Ưu điểm là dễ chuyển thư mục giữa máy, kiểm tra bằng Explorer, dùng trong phòng thi không cần database/web server. Nhược điểm là identity và lịch sử dễ phụ thuộc tên/path; thay dữ liệu mà giữ nguyên tên có thể làm kết quả cũ mất ý nghĩa nếu không kèm hash/version của đề.

Nguồn: [hướng dẫn Themis — cấu hình bài](C:/Themis/~Documentation/themis.html:247), [quy cách ZIP](C:/Themis/~Documentation/themis.html:142).

### 3.3. Compiler và runtime

Themis ánh xạ phần mở rộng sang command template có `%PATH%`, `%NAME%`, `%EXT%`; có `|@WorkDir=...` và có thể gọi chuỗi lệnh qua file BAT. Khi có nhiều kiểu source phù hợp, cấu hình/ưu tiên compiler quyết định file được chọn.

Đây là cách mở rộng thực dụng: người quản trị có thể dùng nhiều compiler mà không sửa Themis. Đổi lại, raw command và cấu hình thủ công làm việc quote path, unicode, môi trường, PATH và tái lập kết quả khó kiểm soát hơn mô hình executable identity + argv có kiểu.

Bộ cài được cung cấp có GCC 9.2.0, cây FPC, Java launcher 7.0.0.0 và Python 3.12.4. Python.exe có chữ ký Authenticode hợp lệ; không nên mô tả toàn bộ bộ cài là tất cả thành phần đều unsigned. Phiên bản FPC đầy đủ và Java update cụ thể chưa được xác minh trong cuộc đánh giá này.

Tài liệu nói Themis ưu tiên JRE đã cài trên máy và dùng JRE trong `JDK` nếu máy chưa có. Hai máy có cùng đề/source nhưng JRE khác nhau có thể chấm khác nhau. JudgeDesk nên giữ invariant chọn công cụ dịch/runtime rõ ràng, không tự đổi sang công cụ khác khi lỗi.

Các phiên bản cũ là lý do cần kiểm tra provenance, compatibility và advisory cụ thể; tuổi phiên bản tự nó không chứng minh một CVE có thể khai thác qua bài nộp. Không có kết luận “Java 7 trong thư mục này đã bị khai thác”.

Nguồn: [cấu hình compiler](C:/Themis/~Documentation/themis.html:331), [chọn Java/Python runtime](C:/Themis/~Documentation/themis.html:382).

### 3.4. Bảy judger và hợp đồng checker

| Judger | Ngữ nghĩa công bố |
|---|---|
| C1 | So danh sách từ theo từng dòng, không phân biệt hoa/thường |
| C2 | Như C1, có phân biệt hoa/thường |
| C3 | So chuỗi từ trên toàn file, không phân biệt hoa/thường |
| C4 | Như C3, có phân biệt hoa/thường |
| C5 | So từng byte |
| C6 AMM2 | EXE đọc `COMPAR$R.INP`, ghi `COMPAR$R.OUT` với DUNG/SAI/SAIDINHDANG/DUNGMOTPHAN p |
| C7 | EXE đọc hai đường dẫn qua stdin, ghi nhận xét và hệ số 0..1 ở dòng stdout cuối |

Các checker C1–C4 công bố xử lý văn bản ASCII; tab và dấu cách là dấu tách từ. Các quy tắc dòng trống, CR/LF và hoa/thường cần giữ đúng, không thay bằng một lệnh `trim().split(/\s+/)` chung rồi gọi là tương thích.

DLL judger chạy **trong tiến trình Themis**. ABI tài liệu là:

```pascal
function Judge(a, b, c, d: PWideChar; var e: PWideChar): double; stdcall;
```

Tương đương C++ là các con trỏ `wchar_t*`, tham số nhận xét `wchar_t**`. Kết quả trả về là hệ số **0..1**, được nhân với điểm test. Đây không phải chữ ký nhận Delphi `string` và cũng không phải hàm trả trực tiếp điểm tối đa như báo cáo cũ mô tả.

Lợi ích DLL nội bộ là giảm chi phí tạo process. Giá phải trả là parser checker, bộ nhớ, lỗi plugin và tiến trình điều khiển dùng chung một miền lỗi. Tài liệu Themis thừa nhận lỗi DLL có thể dừng toàn bộ hệ thống. Tài liệu cũng nói lỗi checker ngoài bị coi là dữ liệu thí sinh không hợp lệ và cho 0 điểm. JudgeDesk nên giữ **JE/lỗi hạ tầng** riêng với WA/PE của thí sinh; không tự quy mọi crash checker thành lỗi thí sinh.

Nguồn: [C1–C7](C:/Themis/~Documentation/themis.html:258), [ABI và xử lý lỗi](C:/Themis/~Documentation/themis.html:526).

### 3.5. Job Object và bảo mật tài khoản

REA quan sát các API và xref Job Object. Decompile function tại `0x6b7614` còn cho thấy tạo Job và gọi `SetInformationJobObject(..., JobObjectBasicUIRestrictions, ..., 4)` với giá trị `0x80`. Theo Microsoft, đây là `JOB_OBJECT_UILIMIT_EXITWINDOWS`, ngăn các process trong Job gọi ExitWindows/ExitWindowsEx; nó **không** chứng minh đã chặn clipboard, USER handles, file hoặc mạng. [UI restrictions](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_ui_restrictions).

Hàm OR bit `0x2000` ở offset LimitFlags của buffer, rồi gọi wrapper `0x6b7894`. Wrapper xác nhận `JobObjectExtendedLimitInformation`, kích thước 0x70 byte, kiểm tra API failure và gọi nhánh báo lỗi. Đối chiếu hai hàm với layout Win32 cho phép suy ra flag `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: khi handle Job cuối cùng đóng thì kết thúc các process thuộc Job. Đây là bằng chứng tĩnh mạnh hơn việc chỉ thấy tên import, nhưng vẫn chưa xác nhận ownership handle và hiệu lực trong tất cả đường chấm. Lệnh đặt UI restriction ở constructor không kiểm tra return ngay trong pseudocode đã quan sát. [Extended/basic limit semantics](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information).

Công nghệ Job thích hợp để quản lý nhóm tiến trình, tài nguyên và kết thúc cây tiến trình. Chưa đủ chứng cứ để khẳng định chính xác mọi flag time/memory/UI mà báo cáo cũ đã liệt kê đều được áp dụng đúng cho compiler, submission và checker.

Job Object riêng lẻ không tạo chính sách cấm đọc file riêng của giáo viên hoặc cấm mạng. Microsoft mô tả giới hạn Job và bảo mật process là các cơ chế phải thiết lập riêng. AppContainer có cơ chế kiểm soát file, credential, network và process riêng. [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation).

Themis còn có chế độ bảo mật dựa trên hai tài khoản Windows **THÍ SINH** và **GIÁM THỊ** cùng NTFS ACL. Điểm dễ bị hiểu sai: tài liệu yêu cầu **Themis chạy dưới tài khoản THÍ SINH**, biết credential GIÁM THỊ, đổi ACL để khóa thư mục đề/bài làm, dùng quyền GIÁM THỊ để đưa dữ liệu vào phòng thi rồi chạy bài dưới quyền THÍ SINH. Khi checker chạy, thư mục test tương ứng được mở quyền rồi khóa lại.

Thiết kế này có mục tiêu rõ: bảo vệ đề/test và bài của người khác bằng account/ACL. Nó đòi hỏi cấu hình tài khoản và quyền chính xác; thay quyền trên dữ liệu thật cũng tạo công việc phục hồi khi crash. Chưa có chứng cứ ở đây về một chính sách zero-network do Themis tự áp đặt. Cũng chưa xác minh Themis có biện pháp bổ sung để bảo vệ memory/handle của tiến trình giữ credential trước process cùng tài khoản hay không.

Không nên kết luận Themis không có bảo mật; cũng không nên gọi cơ chế này tương đương sandbox per-run hiện đại. Nếu chế độ bảo mật chưa bật hoặc account/ACL cấu hình sai, độ bảo vệ thực tế giảm mạnh.

Nguồn: [mô hình tài khoản và ACL Themis](C:/Themis/~Documentation/themis.html:448).

### 3.6. OSD, báo cáo và lưu kỳ thi

OSD là giao thức bằng thư mục: `*[ThíSinh][Bài].EXT`, theo dõi file mới, tạo thí sinh nếu cần, lưu bài cũ vào `$History`, trả file `.log`; điểm bảng lấy bài nộp cuối. Themis hướng dẫn dịch vụ nộp bài ghi file ở nơi khác rồi chuyển vào OSD sau khi ghi xong. Đây là một quy tắc hữu ích để tránh chấm file còn dang dở.

Tài liệu gợi ý nhiều máy chấm, mỗi máy có OSD riêng và dịch vụ bên ngoài phân phối bài. Điều đó không chứng minh Themis có scheduler cluster tích hợp, lease job hay consensus kết quả.

Export kết quả tổng hợp/chi tiết qua Microsoft Excel đang cài, không tự lưu file Excel. File `.contest` là ZIP chứa dữ liệu kỳ thi, cấu hình và kết quả. Chưa fuzz hoặc trace bộ giải nén nên không kết luận có Zip Slip/ZIP bomb đã được chứng minh.

Nguồn: [OSD](C:/Themis/~Documentation/themis.html:390), [export](C:/Themis/~Documentation/themis.html:420), [archive](C:/Themis/~Documentation/themis.html:432).

## 4. So sánh toàn diện

| Khía cạnh | Themis trong bộ cài được cung cấp | JudgeDesk source hiện tại | Đánh giá |
|---|---|---|---|
| Kiến trúc | Delphi/VCL native, EXE chính và DLL judger | React + Tauri + Node/Express + Rust executor; thêm Rust core/Axum thay thế | JudgeDesk dễ mở rộng nhưng nhiều ranh giới và hai backend tăng chi phí bảo đảm tương đương |
| Nền tảng | Windows, tài liệu gồm XP/Vista/7+ | Windows/macOS | JudgeDesk có lợi thế phạm vi; không phải mọi tính năng có cùng độ hoàn thiện ở cả backend/platform |
| Triển khai | EXE nhỏ, cấu hình/thư mục quen thuộc; toolchains riêng | Node SEA sidecar, WebView hệ thống, executor native; Core/Full packages | So sánh tổng footprint và startup trên cùng máy mới có ý nghĩa |
| Ngôn ngữ | Command template mở rộng; bộ cài có C/C++, Pascal, Java, Python | Registry Node có C/C++, Python, Pascal, Go, Java, Rust, JavaScript, C#, Scratch | Phạm vi Node rộng hơn; Rust fallback chưa có cùng coverage |
| Compiler selection | Editable command/PATH/runtime máy | Toolchain pinning, managed receipts, local snapshot/certification | JudgeDesk mạnh hơn ở luồng đầy đủ; fallback Rust/PATH và resource-only làm giảm lợi thế |
| Bộ test | Thư mục theo test; override từng test | Themis-style và flat/Polygon; subtask/group/dependency | JudgeDesk linh hoạt về scoring hiện đại; cần giữ khả năng di chuyển kỳ thi cũ |
| I/O | Nhiều input/output bằng `|`, stdin/stdout riêng | stdin/stdout riêng; runner hiện stage một input và đọc một output | Themis thuận tiện hơn với bài nhiều file; cần contract mảng file rõ ràng |
| Bài nộp | File đơn và ZIP nhiều file | Source theo registry; ZIP source không được OSD chấp nhận; Scratch archive là trường hợp riêng | Chưa tương thích ZIP bài nộp thông thường |
| Source trùng tên bài | Theo ưu tiên cấu hình compiler | Node từ chối `AMBIGUOUS_SUBMISSION` | JudgeDesk an toàn hơn với mơ hồ; migration cần giải thích để người dùng xử lý |
| C1–C5 | DLL gốc | Node/Rust/C++/binaries; corpus parity 67 fixture đã qua | Lợi thế kiểm chứng rõ ràng; corpus hữu hạn không chứng minh mọi input |
| Checker C6/C7 | Có hai protocol legacy rõ ràng | Có C7-like stdin/dòng điểm cuối và testlib; chưa thấy adapter C6 | C7 chưa drop-in tuyệt đối; nên chọn protocol tường minh |
| Interactive | Chưa thấy hỗ trợ tương ứng trong tài liệu khảo sát | Submission/interactor hai tiến trình, pipe và giới hạn | JudgeDesk có lợi thế; cần test bảo mật ở cả hai vai trò |
| Điểm/ranking | ABI hệ số Double; chưa chứng minh exact arithmetic nội bộ | Node/React dùng Rational/BigInt xuyên scoring/ranking; Rust còn parse `f64` | JudgeDesk có thiết kế chính xác tốt hơn, nhưng invariant chưa phủ hết backend |
| Cách ly file/mạng | Account/ACL khi bật bảo mật; zero-network chưa xác minh | Strict AppContainer/LPAC hoặc Seatbelt; nhiều đường resource-only | Strict JudgeDesk mạnh hơn, nhưng hiện chưa thể nói mọi bài đều được cách ly |
| Tài nguyên | Job Object được xác nhận; flags chính xác cần thêm trace | Job memory/process, wall-time, output, write/files/thread, cancellation/drain | JudgeDesk có telemetry/test tốt; một số quota là polling hoặc chưa enforce theo platform |
| Checker crash | DLL có thể dừng app; checker ngoài có thể quy lỗi cho thí sinh | Node có JE, checker timeout/memory/output limit | JudgeDesk xử lý lỗi công bằng và dễ chẩn đoán hơn ở luồng Node |
| OSD | Theo thư mục, history/log; dùng external distributor nếu nhiều máy | Node watcher, FIFO, pause/resume, SSE, history/log | Có nền tảng tương đương; queue cần source snapshot; Rust OSD hiện trả status giả lập |
| Export | Excel COM, cần Excel, người dùng tự lưu | `.xlsx` từ frontend ExcelJS, backend ghi/mở bằng ứng dụng mặc định; có diagnostics | JudgeDesk không cần Excel để tạo workbook; vẫn cần viewer nếu muốn mở |
| Archive | `.contest` ZIP; parser chưa audit | `.judgedesk` có manifest version, path checks, chặn symlink, quotas, save temp/rename | JudgeDesk có biện pháp thể hiện rõ trong source; còn cần kiểm thử đặc thù NTFS/quota byte thật |
| Cập nhật/provenance | Mẫu EXE/judgers unsigned; quy trình cập nhật chưa xác minh | Tauri updater public key, toolchain manifest Ed25519/digests/receipts | JudgeDesk có thiết kế supply-chain tốt hơn; chữ ký installer chính thức chưa kiểm tra ở đây |
| UX | Desktop mật độ dữ liệu cao, F9/F11, menu ngữ cảnh, workflow quen thuộc | Giao diện web desktop, i18n, light/dark, progress/diagnostics | Nên học tốc độ thao tác Themis; không đủ dữ liệu usability để chấm điểm định lượng |
| Hiệu năng | Native UI/monolith, DLL giảm overhead process | Native executor, prewarm/PCH/cache; chi phí IPC/WebView và sandbox | Chưa benchmark đối đầu; không kết luận tổng thể ứng dụng nào nhanh hơn |
| Khả năng kiểm chứng | Closed binary, docs và black-box oracle | Source, automated tests, gates, build metadata | JudgeDesk có ưu thế lớn về audit; test đúng contract quan trọng hơn số lượng test |

## 5. Những vấn đề cụ thể cần ưu tiên trong JudgeDesk

### F1 — P0: Các đường bỏ cách ly file/mạng trong executor

**Bằng chứng mã nguồn:**

- [fallback lỗi 623 trên Windows](D:/Minh/Code/judgedesk/native-executor/src/platform/windows.rs:458) tạo lại process với handle-list và job-list, bỏ `SECURITY_CAPABILITIES`. Nhánh tương tự tồn tại trong spawn interactive tại dòng 1762.
- [native validation](D:/Minh/Code/judgedesk/native-executor/src/request_validation.rs:131) chọn `ResourceOnly` cho managed package `scratch-*`; chọn cùng chế độ cho artifact mang `JUDGEDESK_PASCAL_ISOLATED=1`.
- [Pascal submission preparation](D:/Minh/Code/judgedesk/server/judge/testcase-runner.ts:223) đặt marker Pascal cho bài native; [Scratch adapter](D:/Minh/Code/judgedesk/server/judge/scratch-runtime.ts:200) trả local grant `isolation: "resource-only"`, kể cả khi runtime được chọn từ managed toolchain.
- [Windows launch attributes](D:/Minh/Code/judgedesk/native-executor/src/platform/windows.rs:378) bỏ security capabilities khi resource-only.
- [macOS profile](D:/Minh/Code/judgedesk/native-executor/src/platform/macos.rs:556) trả `(allow default)` cho resource-only, chỉ giữ một số deny liên quan thoát nhóm tiến trình.

**Hệ quả:** Job/guardian vẫn có thể giới hạn thời gian, RAM và cây tiến trình, nhưng quyền truy cập file/mạng không còn bị giới hạn theo workspace. Pascal là code native do thí sinh kiểm soát nên hệ quả trực tiếp. Scratch là dữ liệu chạy trong runtime; không khẳng định mọi project Scratch có sẵn primitive đọc file host, nhưng runtime không có boundary OS cần thiết nếu parser/runtime bị khai thác.

Đây là vi phạm invariant fail-closed đã công bố, không chỉ là chi tiết tương thích compiler. Đặc biệt, fallback 623 ở lớp Windows có thể xảy ra sau khi tầng admission đã xác nhận strict, kể cả với checker native. Interactive validation đòi strict nhưng nhánh spawn vẫn có thể bỏ boundary sau lỗi 623.

**Hướng xử lý:** mọi compiler/submission/checker/interactor phải có policy theo role và được chứng minh giữ cách ly. AppContainer launch thất bại phải trả lỗi hạ tầng rõ ràng. Xử lý legacy executable bằng rebuild/verified toolchain hoặc một boundary OS khác thực sự cô lập; không đổi teacher token thành “safe” chỉ vì process còn trong Job. Đưa effective isolation vào từng run result và metadata.

### F2 — P0: Policy mặc định/migration/import Themis tự nới bảo mật

[SAFE_DEFAULT](D:/Minh/Code/judgedesk/server/toolchains/execution-policy.ts:20) đặt `allowResourceOnlyLocalExecution: true`; policy thiếu, lỗi đọc hoặc JSON không hợp lệ cũng quay về true. [Migration](D:/Minh/Code/judgedesk/server/toolchains/migration.ts:347) chuyển false thành true. [Import Themis all](D:/Minh/Code/judgedesk/src/features/toolchains/useThemisPromptModal.ts:120) tự PUT true trước khi chọn toolchain.

[Local admission](D:/Minh/Code/judgedesk/server/toolchains/local-execution.ts:178) có thể trả ready resource-only khi strict probe chưa xong hoặc đã thất bại. Test hiện còn xác nhận default true và migration false→true; vì vậy test xanh đang bảo vệ chính sách nới lỏng này. Help/i18n vẫn nói tắt là lựa chọn khuyến nghị.

**Hướng xử lý:** default/recovery=false; migration giữ quyết định chặt hơn của người dùng; chọn công cụ Themis không tự đổi security policy. Tách compatibility khỏi sandbox readiness. Công cụ không tương thích strict không được quảng bá là sẵn sàng chấm an toàn. Không dùng một global switch để mở rộng quyền cho nhiều role/ngôn ngữ ngoài phạm vi lựa chọn người dùng.

### F3 — P0/P1: Backend Rust thay thế có nghiệp vụ chưa hoàn chỉnh nhưng được tự kích hoạt

[Tauri backend](D:/Minh/Code/judgedesk/src-tauri/src/backend.rs:260) có thể vào Rust core qua `JUDGEDESK_PURE_RUST_CORE` hoặc tự fallback khi sidecar không có/không spawn được.

Trong backend đó:

- [compiler](D:/Minh/Code/judgedesk/crates/judgedesk-core/src/engine/compiler.rs:18) gọi `Command::new("g++")`, `gcc`, `fpc` trực tiếp từ PATH, `.output()` ngoài executor; không có budget compiler trong đường này và không dùng cùng pin/certificate của Node.
- [certify](D:/Minh/Code/judgedesk/crates/judgedesk-core/src/server/mod.rs:1478) trả certificate cố định `cert-local-native` và thời điểm cố định, không thực hiện certification.
- [execution policy](D:/Minh/Code/judgedesk/crates/judgedesk-core/src/server/mod.rs:1410) chỉ trả lại JSON body; GET toolchains công bố resource-only=true.
- [install](D:/Minh/Code/judgedesk/crates/judgedesk-core/src/server/mod.rs:1551) đánh dấu package trong set và trả success, không thực hiện chuỗi download/verify/install như Node.
- [OSD start/status/stop](D:/Minh/Code/judgedesk/crates/judgedesk-core/src/server/mod.rs:1708) trả các status hằng; events chỉ có comment connected, không có watcher/job pipeline tương ứng.

**Hệ quả:** người dùng có thể thấy thành công/readiness/certified mà thao tác tương ứng chưa xảy ra. Compiler có thể được đổi theo PATH; việc ngăn source gây tiêu thụ tài nguyên compiler không còn được bảo đảm bởi luồng này. Đây là sai lệch contract sản phẩm; với certification và cách thực thi compiler còn là sai lệch an ninh.

**Hướng xử lý:** backend chưa đạt conformance không được tự thay backend production. Trả lỗi unavailable/unsupported trung thực cho tính năng chưa làm. Hoàn thiện parity về side effect, role isolation, toolchain identity, scoring, OSD, cancellation trước khi bật fallback. Không dùng một test schema/HTTP success thay cho chứng cứ rằng chức năng đã được thực hiện.

### F4 — P1: Local HTTP API chưa xác thực từng request

[Express server](D:/Minh/Code/judgedesk/server.ts:63) đặt CORS allowlist nhưng không reject origin ngoài allowlist và không có session authorization middleware. API gồm thay cấu hình, chấm, policy toolchain và shutdown. [apiFetch](D:/Minh/Code/judgedesk/src/api.ts:32) không truyền token xác thực phiên.

Bootstrap token tồn tại trong [server-bootstrap](D:/Minh/Code/judgedesk/server-bootstrap.ts:7); nó xác thực kênh **khởi động/parent**, không xác thực HTTP caller sau khi server đã chạy. Đây là hai nhiệm vụ khác nhau.

[Axum router](D:/Minh/Code/judgedesk/crates/judgedesk-core/src/server/mod.rs:287) còn dùng CORS `Any` cho origin/method/header. Cả hai lắng nghe loopback, điều này giảm phơi bày tới mạng LAN nhưng không ngăn process local gọi API. Khả năng trang web gọi localhost còn phụ thuộc browser và chính sách private-network/origin; chưa tái hiện một khai thác browser trong phiên này.

F1 và F4 còn có thể kết hợp: program resource-only không bị chặn mạng theo OS có cơ hội tiếp cận backend loopback thiếu authorization. Đây là hệ quả thiết kế cần chặn ở cả hai boundary, chưa phải exploit end-to-end được chạy trong phiên này.

[Tauri config](D:/Minh/Code/judgedesk/src-tauri/tauri.conf.json:25) đặt CSP=null. Chưa tìm thấy sink HTML/eval rõ ràng trong phạm vi tìm kiếm frontend; CSP là biện pháp bổ sung cần thiết, không phải bằng chứng có XSS đã được khai thác. [Tauri CSP](https://v2.tauri.app/security/csp/).

**Hướng xử lý:** session capability/token do Tauri cấp, xác thực toàn bộ request có quyền đọc/ghi/chấm và SSE; reject Origin/Host bất hợp lệ; giới hạn body theo endpoint; giữ server loopback; cấu hình CSP tối thiểu cho assets và backend endpoint đang dùng. Áp dụng cùng contract cho cả Node và Axum. Không dựa riêng vào số port ngẫu nhiên hay CORS.

### F5 — P1: OSD queue không giữ source bất biến theo job

[Watcher](D:/Minh/Code/judgedesk/server/judge/osd-watcher.ts:280) đưa bài vào path chung `Contestants/<name>/<problem>.<ext>`, rồi job lưu path đó. [Service](D:/Minh/Code/judgedesk/server/judge/osd-service.ts:110) queue job; tới lúc chấm mới gọi compile với [job.filePath](D:/Minh/Code/judgedesk/server/judge/osd-service.ts:374).

**Suy luận có độ tin cậy cao từ control flow:** khi queue đang chờ hoặc pause, bài A và B cùng thí sinh/bài/ngôn ngữ có cùng filePath. B chuyển A vào History và thay path chung. Khi A được compile, path có thể chứa B; đổi ngôn ngữ còn có thể làm path cũ biến mất. Original filename/log/job ID có thể không còn tương ứng bytes đã chấm.

**Đã tái hiện ở ranh giới watcher/job:** giữ lại job A mà chưa chấm, ingest B cùng ngôn ngữ, đọc `A.filePath` nhận bytes B; sau khi ingest C khác ngôn ngữ, `A.filePath` không còn tồn tại. Diagnostic dùng dữ liệu giả, không compile/chạy bài nộp và không đổi mã sản phẩm; các fixture tạm đã được dọn. [Script tái hiện](D:/Minh/Code/judgedesk/docs/reports/osd-source-identity-proof-2026-10-11.mts).

Test watcher hiện kiểm tra di chuyển/history, chưa khẳng định source bytes của mỗi queued job giữ nguyên sau resubmit. Chưa chạy reproduction end-to-end qua compiler và bảng điểm; hệ quả chấm nhầm ở service là suy luận từ việc service đọc path này về sau.

**Hướng xử lý:** snapshot từng lần nộp ngay khi ingest, gắn SHA-256 và submission ID, chấm snapshot ấy; “latest” chỉ là con trỏ hiển thị. Log và result gắn submission ID/hash. Thêm test pause→nộp A→nộp B→resume và test đổi ngôn ngữ; policy latest/best phải được định nghĩa riêng với identity source.

### F6 — P1/P2: Rational invariant chưa phủ đường Rust và custom checker

Luồng Node và bảng điểm React dùng phân số chính xác. Nhưng [Rust rational parser](D:/Minh/Code/judgedesk/crates/judgedesk-core/src/rational.rs:110) parse chuỗi số/tử/mẫu qua `f64`, rồi dùng heuristic continued fraction. [Custom checker](D:/Minh/Code/judgedesk/crates/judgedesk-core/src/checkers/custom.rs:3) giữ multiplier `f64`; [session](D:/Minh/Code/judgedesk/crates/judgedesk-core/src/engine/session.rs:447) chuyển multiplier đã qua float về Rational.

Ví dụ boundary: chuỗi số nguyên `9007199254740993` không được biểu diễn chính xác trong IEEE-754 double; chuyển nó sang Rational sau đó không khôi phục thông tin đã mất. Những decimal/fraction với độ chính xác cao cũng có thể bị xấp xỉ. Mức ảnh hưởng thực tế phụ thuộc cấu hình điểm và backend được chạy.

Quality gate hiện không cấm toàn bộ đường này: quy tắc Rust `parse::<f64>` bị giới hạn ở `scoring.rs`, trong khi parser nằm ở `rational.rs` và checker/session ở module khác. Do đó `check:fast` xanh không chứng minh invariant điểm đã đúng xuyên các tầng.

**Hướng xử lý:** parse chuỗi decimal/fraction trực tiếp thành integer numerator/denominator với kiểm tra overflow; multiplier cũng là Rational. Conformance corpus so exact serialization, tổng điểm và thứ hạng giữa Node/Rust, gồm phần lẻ dài, phân số lặp, partial score, near-tie và giới hạn integer. Giữ float cho tolerance số thực của checker/telemetry nếu phù hợp, không dùng cho điểm/ranking.

### F7 — P2: Quota cần công bố đúng mức enforce

Protocol có `openFiles`, nhưng khảo sát source Windows chỉ thấy validation/default/test data cho field này, chưa thấy enforcement trong runner. macOS có RLIMIT_NOFILE. Windows thread count và write/created-file quota là polling; runner còn tránh scan nặng trong 100 ms cuối trước deadline. Đây không phải kernel hard quota như Job memory/process.

Polling có thể phát hiện sau khi tài nguyên đã tăng và thread count failure đang dùng `unwrap_or(0)`, có thể coi lỗi quan sát như không có thread. Cần tách **hard limit**, **observed limit** và **unsupported** trong capability/result; không quảng bá các field protocol như bảo đảm OS đồng nhất.

Nguồn: [Windows monitor](D:/Minh/Code/judgedesk/native-executor/src/platform/windows.rs:584), [limit validation](D:/Minh/Code/judgedesk/native-executor/src/request_validation.rs:658), [macOS RLIMIT](D:/Minh/Code/judgedesk/native-executor/src/macos_launcher.rs:1510).

### F8 — P2: Tương thích C7 có chi tiết chưa giữ nguyên

Themis C7 yêu cầu hai đường dẫn stdin có dấu `\` cuối. JudgeDesk [ghi themis.stdin](D:/Minh/Code/judgedesk/server/judge/custom-checker-runner.ts:144) bằng `${testDir}\n${workDir}\n`, không thêm separator cuối. Checker cũ nối thẳng `dir + filename` có thể lỗi.

Parser điểm còn đoán giữa multiplier 0..1, điểm tuyệt đối và exit code testlib. Điều này hữu ích cho checker hỗn hợp nhưng khó bảo đảm migration chính xác. Nên chọn rõ `themis-c7`, `amm2-c6`, `testlib` hoặc một protocol riêng; với C7 phải kiểm tra bắt buộc dòng điểm hợp lệ và dùng Rational. C6 cần adapter file protocol có cách ly riêng, không chỉ đổi tên checker.

### F9 — P2: Dependency audit cần xử lý theo reachability

`npm audit --omit=dev --json` tại thời điểm đánh giá báo **5 package bị ảnh hưởng**: 1 critical, 1 high, 3 moderate. Đây là số package trong dependency graph, không phải 5 lỗ hổng độc lập hoặc 5 đường khai thác đã chứng minh trong JudgeDesk.

| Package đang dùng | Vai trò | Nhận định |
|---|---|---|
| express 4.22.2 / body-parser 1.20.6 / qs 6.15.2 | HTTP/query/form parsing | Cần triage DoS parser, giảm body 50 MB và xác thực API; không chạy payload DoS trong phiên này |
| proxy-addr 2.0.7 | Dependency Express, trust proxy/IP resolution | Advisory critical đòi cấu hình trust subnet liên quan; chưa thấy JudgeDesk bật trust proxy kiểu đó |
| brace-expansion 1.1.18 và 2.1.4 | Qua ExcelJS/archiver/minimatch | Cần xác minh pattern nào do dữ liệu không tin cậy kiểm soát và phần nào thực sự vào bundle production |

Nguồn: [advisory của proxy-addr](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h), [brace-expansion](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), [qs](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g). Advisory không thay thế phân tích luồng dữ liệu trong ứng dụng. Không dùng `audit fix --force` hàng loạt; cập nhật có chọn lọc, review lockfile và chạy regression. Rust dependency CVE và toàn bộ toolchain CVE chưa được quét đầy đủ trong phiên này.

## 6. Những điểm JudgeDesk đã làm tốt nên giữ

- Strict Windows dùng capability riêng cho workspace, ACL cho cache/workspace, AppContainer/LPAC và tạo process gắn Job ngay tại CreateProcess; giảm cửa sổ process/memory trước khi được quản lý.
- Strict macOS có policy filesystem/network, quản lý identity/cây tiến trình và guardian. Cần giữ mặc định deny thay vì compatibility allow-default.
- Compiler, submission, checker và runtime có role trong protocol. Native checker/managed runtime được phân biệt thay vì dựa vào một chuỗi shell chung.
- Node có giới hạn output 16 MiB; checker output 256 KiB, timeout/memory riêng; cancellation chờ terminal drain. Các test đọc/ghi ngoài workspace và sibling workspace có giá trị rõ ràng.
- Checker C1–C5 xử lý byte/ASCII có corpus; nhiều checker Polygon bổ sung. Rational scoring/ranking ở Node/React là lợi thế cần duy trì xuyên backend.
- Managed toolchain có manifest signing/digests/receipts và snapshot certification cho local C++ được hỗ trợ. Cần làm đường local/import/alternative backend tuân thủ cùng contract.
- `.judgedesk` có versioned manifest, reject path không nằm trong archive, reject symlink, duplicate entries, entry count/size budgets và ghi archive qua file tạm. Chưa có lý do để thay nguyên bằng archive Themis không có manifest.
- Readiness/prewarm/PCH cùng metadata giúp giáo viên biết hệ thống chuẩn bị đến đâu. Nên mở metadata cho tất cả ngôn ngữ và effective isolation, hiện `createRunMetadata` tập trung C++/Python.

## 7. Lộ trình hoàn thiện đề xuất

| Ưu tiên | Công việc | Điều kiện hoàn thành có thể kiểm chứng |
|---|---|---|
| P0 | Đóng mọi đường tự mất sandbox; Pascal/Scratch/623/local cùng policy fail-closed | Mọi role/ngôn ngữ bị từ chối nếu không tạo boundary; test read/write/network âm tính theo từng đường chạy, kể cả error injection |
| P0 | Sửa default/recovery/migration/import Themis | Policy thiếu/hỏng vẫn strict; lựa chọn compiler không tự thay quyền; quyết định false không bị migration đảo |
| P0/P1 | Ngăn production fallback vào backend chưa conformance | Sidecar lỗi tạo diagnostic rõ; không có certify/install/OSD success giả; mọi compile qua executor, toolchain được pin |
| P1 | Xác thực HTTP và CSP | Request thiếu/sai session token hoặc Origin/Host bị reject trên Node/Axum; SSE có authorization; app vẫn hoạt động với CSP |
| P1 | Snapshot OSD theo submission ID/hash | Hai bài cùng tên đang queued vẫn chấm đúng bytes; đổi ngôn ngữ không làm mất source; restart/cancel policy có test |
| P1/P2 | Exact rational xuyên Rust/Node/UI/export | Corpus exact score/ranking và partial checker cho kết quả như nhau, không parse điểm qua f64 |
| P2 | Migration assistant Themis | Import settings có báo cáo trường được chuyển/chưa hỗ trợ; C6/C7 explicit; multi-I/O/ZIP được validate; không âm thầm đổi điểm |
| P2 | Quota/capabilities trung thực | Field nào kernel enforce/poll/unsupported được công bố; lỗi quan sát không được coi là zero usage |
| P2 | Triage và cập nhật dependency đang bị advisory | Reachability có tài liệu, lockfile review, regression; không chỉ dựa vào số audit |
| P2 | Run manifest và history bất biến | Hash source/tests/checker/toolchain, argv, OS/arch, config, effective isolation và run ID đủ tái lập/rejudge |
| P3 | Đo và tối ưu hiệu năng | Benchmark cùng máy/cùng toolchain/cùng dữ liệu; p50/p95/p99 startup/compile/run/queue, CPU/RAM; không đánh đổi boundary |
| P3 | UX cho giáo viên | Preflight dễ hiểu, lỗi toolchain có hành động khắc phục, preview checker migration, phím tắt/chấm chọn rõ; light/dark/focus không regress |

Với multi-file ZIP, cần thiết kế từ contract: entrypoint xác định, không shell evaluation, reject traversal/symlink/NTFS ADS/reserved names/case collisions, quota entry và byte giải nén thật, snapshot bất biến, không giải nén đè dữ liệu kỳ thi. Không nên chỉ thêm `.zip` vào extension registry.

Với nhiều máy chấm, chỉ triển khai sau khi có source/test/toolchain identity bất biến và kết quả idempotent. Cần lease job, retry sau crash, chống chấm trùng, pin version và policy lấy latest/best rõ ràng. Tăng số process đồng thời trên một máy trước khi đo có thể làm TLE nhạy với tải hệ thống.

## 8. Kiểm chứng đã thực hiện

| Kiểm tra | Kết quả |
|---|---|
| `npm run check:fast` | PASS: TypeScript và quality invariant gate |
| `npm run test:server` | PASS: 118 file test được chọn; 815 test, 805 pass, 0 fail, 10 skip có điều kiện; 410,4 s. Có Node judging corpus oracle, không phải Themis DLL oracle |
| `npm run test:security` | 17 test: 16 pass, 0 fail, 1 skip do test đặc thù macOS trên host Windows; khoảng 495,7 s gồm provisioning/teardown |
| `npm run test:themis-parity` | PASS: 67 fixture ở Node, Rust core, compiled C++, Windows packaged C1–C5; BUILD_MANIFEST hashes được xác minh |
| `npm run check:full` | FAIL ở Rust core `executor_boundary_test`; 8/9 bước Rust PASS. Chuỗi full dừng trước server/parity/version; các child này được chạy riêng, không coi full đã PASS |
| Focused `executor_boundary_test` | Tái hiện: 27 test, 4 pass, 23 fail tại assertion frozen packaged executor identity |
| `npm run release:check-version` | PASS: 1.5.5, 8-file authority lockstep |
| OSD source identity diagnostic | Tái hiện watcher/job path thay bytes sau resubmit; không chạy compiler/scoreboard |
| `npm audit --omit=dev --json` | Có advisory: 5 affected packages; không tự sửa dependency |
| REA/PE inspection | Identity/resources/native overview/import xref và hai function dossier; static analysis, không quan sát Themis chấm trực tiếp |

Parity gate đã chạy là corpus tĩnh của project. **Chưa chạy live Themis DLL oracle** trong cuộc đánh giá này; không mô tả 67 fixture đã được so trực tiếp với DLL Themis trong phiên này. Cũng chưa benchmark trực tiếp Themis/JudgeDesk, chưa kiểm thử runtime macOS, chưa fuzz Themis archive/DLL và chưa audit một installer JudgeDesk release cụ thể.

Nguyên nhân focused Rust failure được xác minh bằng `Get-FileHash`: executor đóng gói hiện tại SHA-256 `1D1F8E390B2333402C5DEFF5F65651A9F169B21FFFE254733A3455D7A4861AC9`, trong khi [test ghim](D:/Minh/Code/judgedesk/crates/judgedesk-core/tests/executor_boundary_test.rs:149) `EAB2EDDA46C732585E38AAA08E1E0DA2248818F803376E032CA63EB7D8918622` và 950.784 byte. Phần lớn test dừng trong helper kiểm tra identity trước khi tới scenario executor. Đây không phải 23 sandbox escape đã quan sát. Không thay hash, bỏ assertion hoặc cập nhật frozen candidate chỉ để gate xanh; cần workflow tái xác minh artifact/source identity có chủ đích.

Test strict xanh chứng minh các đường strict được test hoạt động trên host này; nó không chứng minh đường resource-only có cách ly. Quality gate xanh cũng không thay thế review control flow ở fallback/marker/certification. Chính sự khác biệt này cần được đưa thành regression test trước lần phát hành tiếp theo.

## 9. Những điều cần thêm chứng cứ nếu muốn đánh giá Themis sâu hơn

1. Trace caller SetInformationJobObject để xác nhận flags/quota và cách xử lý lỗi theo compiler/submission/checker.
2. Trong VM dùng dữ liệu giả, trace tạo process/token/ACL và test read/write/network, sibling data, truy cập process/handle, cancellation/crash.
3. Fuzz có quota với input của C1–C7, DLL ABI, `.contest` và submission ZIP; xác nhận verdict khi checker lỗi.
4. Benchmark cùng source và cùng compiler/runtime version; đo cả CPU user/kernel, wall time, peak process/job memory và throughput OSD.
5. Kiểm tra DLL search order, chữ ký/nguồn cập nhật của bộ cài chính thức và cách phục hồi ACL sau app/host crash.

Những bước này cần môi trường thử nghiệm riêng và artifact identity cố định. Chúng mở rộng độ chắc chắn của kết luận; không thay đổi các lỗi JudgeDesk đã được thấy trực tiếp trong source ở mục 5.
