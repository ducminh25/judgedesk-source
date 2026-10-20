# JudgeDesk — Báo cáo nghiệm thu Native UI

Ngày: 2026-10-14, Windows x64. Reviewer: Codex, Computer Use `@oai/sky`.
Đã đọc AGENTS.md, CONSTRAINTS.md, guidelines.md, judgedesk-frontend và báo cáo hardening, gồm các dòng 408–414 và 579–632. Không commit/push, thay dependency, sửa native-executor/crates hay chạy thao tác Git hoàn nguyên.

## 1. Kết luận tổng quan

| Gate | Kết luận | Bằng chứng / giới hạn |
|---|---|---|
| UI 1 — Bước 5, Normal Session/CSP | **PASS tại focused delta 3** | Both requested configurations passed. Language/theme toggles stayed Ready with Judge enabled; no red connection toast. [#109](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/normal-dark-en-language-ready.jpg), [#120](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/max-light-en-delayed-ready-no-toast.jpg). Scope and identity: Section 7. |
| UI 2 — Bước 3, F6 | **PASS tại focused delta 3** | Managed → requested Themis Local Path → Managed passed in Normal Dark/VI and Maximized Light/EN, without red error or retry. [#107](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/normal-dark-vi-managed-return.jpg), [#116](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/max-light-en-managed-return.jpg). Earlier semantic/focus/matrix evidence retained; no uninstall/install rerun. |
| UI 3 — Bước 5, Startup Failure/Retry | **PASS — phạm vi lỗi IPC mô phỏng** | Đủ 8 tổ hợp alert + busy: không trắng màn hình, accessibility tree nhận `alert`, thông báo VI/EN rõ, focus rõ, Enter retry và nút disabled khi bận, rồi trở về lỗi. Tab quay lại nút đã kiểm tra ở Normal Dark/EN và Narrow Dark/VI. Không token/raw stack trong nội dung UI; không quan sát fallback. Không bao gồm lỗi spawn backend/native startup dialog. |
| UI 4 — Clean teardown / hygiene | **PASS** | [#121 final dark/VI Ready](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/final-dark-vi-ready.jpg); Alt+F4 exit 0, zero remaining processes/profiles, preferences and frozen hash preserved. [Receipt](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/hygiene-receipt.json). |
| macOS | **NOT_RUN** | Máy Mac offline; không thay đổi kết luận runtime macOS. |

Ở lượt đầu, Normal được chụp frame maximized **1536×792**. Narrow dùng overlay hiện có `artifacts/ce-je-ui/narrow-config.json` với **client 960×600**; JPEG gồm title bar/border là **962×631**. Không gọi ảnh Narrow là JPEG 960×600. DPI chưa đo.

## 2. Bằng chứng và screenshot

- [Danh mục 49 screenshot lượt đầu + 35 screenshot delta + 19 screenshot delta 2 + 18 screenshot delta 3: đường dẫn tuyệt đối, kích thước, Light/Dark, VI/EN và SHA-256](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/screenshots.md).
- [Manifest JSON](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/screenshots.json); mỗi JPEG có `.accessibility.txt` cùng tên. Đã kiểm lại toàn bộ hash từ bytes trên đĩa.
- Native dev bắt đầu bằng `npm run test:desktop`; Narrow bằng `npm run test:desktop -- --config artifacts/ce-je-ui/narrow-config.json`. Các lượt lỗi tiếp theo mở lại đúng `src-tauri/target/debug/themis-v2.exe` với Vite DISABLE_HMR=true, không dùng browser thay cửa sổ native. Log tại cùng thư mục evidence.
- Fixture: `artifacts/ce-je-ui/verified-fixture.judgedesk`, 1 thí sinh ẩn danh / 4 bài. Chỉ tải kết quả lưu sẵn; không dùng làm bằng chứng judging end-to-end.
- Fault injection chỉ sửa tạm `src/api.ts`: gọi command IPC không tồn tại `get_backend_session_ui_acceptance_failure`, trì hoãn 1500ms để chụp busy. Theme/language đi qua preferences/i18n hiện có. Sau mỗi cặp ảnh alert/busy đã hoàn trả nguyên byte source. Retry thực sự đi qua initializer và nhận IPC rejection; không giả markup lỗi hoặc bỏ kiểm tra session. Không kiểm chứng recovery thành công bằng nút Retry; khởi động bình thường sau hoàn trả đã quan sát riêng.

## 3. Phát hiện và giới hạn accessibility

Các mục 1–6 dưới đây là lịch sử lượt đầu. Kết quả sửa ở mục 5; trạng thái mới nhất ở mục 7; không coi toàn bộ findings lịch sử vẫn đang mở.

1. **P2 — Menu Công cụ che F6.** Mở menu rồi nhấn F6: menu vẫn nổi trên modal và che cột Actions. Bằng chứng `normal-light-vi-f6-menu-overlap.jpg`. [AppToolbar.tsx:580](D:/Minh/Code/judgedesk/src/components/AppToolbar.tsx:580) dùng z-index 80; [ToolchainManager.tsx:66](D:/Minh/Code/judgedesk/src/features/toolchains/ToolchainManager.tsx:66) dùng z-index 50. Cần đóng menu khi mở modal hoặc thống nhất tầng modal.
2. **P2 — Thông báo chính sách chưa đúng Windows.** Notice vẫn nói C/C++/Python local được tự động kiểm tra trong strict sandbox, trong khi C++ cần freeze và C/Python managed_only. [vi.json:647](D:/Minh/Code/judgedesk/src/locales/vi.json:647), [en.json:648](D:/Minh/Code/judgedesk/src/locales/en.json:648). Lý do radio disabled chỉ nói không tương thích policy; nên giải thích trực tiếp managed_only và workflow freeze.
3. **P2 — Dịch trạng thái VI gây hiểu nhầm.** C++ local đã phát hiện MSYS2 16.1.0 và hiển thị đúng path nhưng badge ghi “Không tìm thấy”; EN ghi “Not available”. [vi.json:660](D:/Minh/Code/judgedesk/src/locales/vi.json:660). Nên dùng “Chưa khả dụng” hoặc nhãn tương đương với trạng thái thiếu chứng nhận.
4. **P2 — F6 thiếu semantic modal/focus contract.** Wrapper tại [ToolchainManager.tsx:66](D:/Minh/Code/judgedesk/src/features/toolchains/ToolchainManager.tsx:66) không có role=dialog/aria-modal; xử lý bàn phím tại dòng 53 chỉ xử lý Escape. Accessibility tree vẫn chứa controls nền. Ô path có focus ring quan sát được, nhưng chưa chứng minh focus confinement/return-focus; không ghi PASS accessibility toàn diện. `focused_element` của Computer Use đôi khi giữ pane/document cũ dù ảnh cho thấy focus thay đổi, nên không dùng riêng trường này để kết luận focus leak.
5. **Cần điều tra — lỗi mạng thoáng qua.** Một khung sau khi mở lại F6 Narrow Light/VI hiện `Failed to fetch`, sau đó registry tải thành công mà không thao tác thêm. Khung lỗi chỉ có trong output Computer Use, chưa lưu JPEG; ảnh ổn định là `narrow-light-vi-f6-freeze.jpg`. [useToolchains.ts:262](D:/Minh/Code/judgedesk/src/features/toolchains/useToolchains.ts:262) hiển thị caught.message chưa dịch. Chưa xác định nguyên nhân request; không quy kết CSP/session hay backend crash.
6. **Cần đối chiếu Bước 6 — shutdown warning.** Log [native-failure-narrow-dark-en.log](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/native-failure-narrow-dark-en.log) ghi sidecar exit 1245970448, lỗi đọc shutdown response `os error 10060`, giữ instance lease tới process exit. Nơi phát cảnh báo: [lib.rs:197](D:/Minh/Code/judgedesk/src-tauri/src/lib.rs:197), read timeout: [backend.rs:153](D:/Minh/Code/judgedesk/src-tauri/src/backend.rs:153). Đã đóng bằng Alt+F4; process cuối cùng thoát. Chưa tái hiện/định nguyên nhân; lượt hậu kiểm khởi động bình thường đóng với sidecar code 0.

Narrow cần cuộn ngang toolbar và bảng F6; nút Freeze bị cắt ở vị trí ban đầu nhưng đọc đầy đủ sau cuộn ngang (`narrow-light-en-f6-horizontal-scroll.jpg`). Footer luôn tiếp cận được, không thu nhỏ font để ép cột. Startup Failure không tràn chữ trong cả 8 tổ hợp. Contrast tính từ token source của màn lỗi: muted text Light **4.55:1**, Dark **6.91:1**; focus outline Light **7.90:1**, Dark **9.98:1**. Đây là kiểm tra token, không phải audit contrast toàn bộ F6.

Không click Freeze, Self-Test, install/uninstall, không tạo snapshot MSYS2 hoặc thay security policy. Khi C++ tạm chọn local, trạng thái chưa sẵn sàng vẫn được giữ; không âm thầm chuyển sang managed.

## 4. Hygiene Receipt

| Kiểm tra | Kết quả |
|---|---|
| Preferences | **dark / VI** đã quan sát ở lượt khởi động sau hoàn trả; compiler preferences `toolchains.json` khôi phục nguyên byte, menu G++/Python sẵn sàng |
| Source/working tree ban đầu | **127/127 baseline files khớp SHA-256**, 0 mismatch; thêm báo cáo/evidence, giữ mọi dirty changes có sẵn |
| Frozen receipt inputs | **30/30 khớp**, 0 mismatch |
| Process | **0** themis-v2 / server / judgedesk-native-executor / judgedesk-executor |
| `%LOCALAPPDATA%/Packages/JudgeDesk.Run.*` | **0** thư mục |
| Binary size/hash | Cả binary target-specific và staged đều **964096 bytes**, SHA-256 **fd2c06d8c0b9baaa24051c9044e4166904d7f43459899db54d3019dc69eb2b24** |
| `npm run check:fast` | **PASS**, exit 0; typecheck + quality invariants |
| `git diff --check` | **PASS**, exit 0 |

**Sửa thông tin đường dẫn trong checkpoint:** `native-executor/target/release/judgedesk-native-executor.exe` không tồn tại ngay từ baseline. Binary đúng hash thực tế ở `native-executor/target/x86_64-pc-windows-msvc/release/judgedesk-native-executor.exe`; receipt chính thức trỏ bản staged `src-tauri/binaries/judgedesk-executor-x86_64-pc-windows-msvc.exe`. Không tạo file thay thế tại đường dẫn thiếu và không rebuild standalone executor.

Receipt máy đọc: [hygiene-receipt.json](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/hygiene-receipt.json). Gate logs: [check-fast.log](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/check-fast.log), [git-diff-check.log](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/git-diff-check.log). Không chạy lại check:full/test:server vì phạm vi observation, không có thay đổi runtime cuối cùng và các script đó rebuild executor; full gate trước đó thuộc evidence Antigravity, không được ghi thành lượt kiểm thử mới của reviewer.

## 5. Delta re-verify — 2026-10-14

> Lịch sử candidate 688030…; kết luận hiện tại đã được thay bởi focused delta 2 tại mục 6.

**Kết luận:** các sửa frontend chính đã quan sát đạt, nhưng Gate UI 1 chưa đóng và Gate UI 2 chưa thể chốt toàn candidate do lỗi lựa chọn C++ local. Gate UI 3 giữ nguyên PASS của lượt trước, không fault-inject/retest; macOS vẫn NOT_RUN trong lượt reviewer Windows này.

### Artifact và phương pháp

Không rebuild. Dùng `vite preview --host localhost --port 5173 --strictPort` để phục vụ **dist đã build**, mở native `src-tauri/target/debug/themis-v2.exe` bằng CLI, mọi thao tác UI bằng Computer Use. `target/debug/judgedesk.exe` được nêu trong yêu cầu không tồn tại; executable thực tế là themis-v2.exe, SHA-256 `067cc6cc70c43f378d588552950fe9cfbcc4148c4698e88ebdbc687defc13dbb`.

Có hai leg phải phân biệt:

- **Preflight/frontend matrix:** debug/server.exe là build `2026-10-14T05:57:39.998Z`, SHA-256 `178cb5e9c85ce697518af386389d74761f27aba27e5eec02ba318bfce96fccae`. Cùng frontend mới `index-D1eneujb.js`, SHA-256 `4e287bc73dc2113b0a7475a340a614128f7e0b4afb5c07135a0d09f4934aab5f`; đủ Light/Dark × VI/EN × Normal/Narrow. Không dùng leg này để tuyên bố backend candidate mới PASS.
- **Candidate đúng:** staged sidecar mới `src-tauri/binaries/server-x86_64-pc-windows-msvc.exe` là build `2026-10-14T05:59:58.440Z`, SHA-256 `688030566b94c5703d553e9e3cd94bd0191997f0cd3fe426bf6ffca38a925741`. Đã copy tạm nguyên bytes vào debug/server.exe khi mọi process đóng, xác nhận startup identity/port 59875, tái hiện riêng lỗi C++ local 2/2 tại Normal Dark/VI. Sau test hoàn trả debug sidecar nguyên bytes. Không sửa shell/executor/source để staging.

### Sáu điểm delta

| Điểm từ lượt đầu | Re-verify | Bằng chứng / phạm vi |
|---|---|---|
| 1. Menu che F6 | **PASS frontend delta** | Menu tự đóng khi nhấn F6; không còn menu đè modal. Native named dialog và ảnh đối chứng trước/sau. |
| 2. Policy notice và chú thích nguồn | **PASS frontend delta** | Warning đã nói managed/certified freeze/platform-approved, không còn hứa tự động probe Windows C/Python. Dòng freeze_required dưới C++ local và managed_only dưới radio C/Python bị khóa hiển thị rõ cả 8 tổ hợp ở leg preflight; không phải tooltip riêng. |
| 3. Badge VI | **PASS visual / PARTIAL combined candidate** | “Chưa khả dụng” đã quan sát ở cả bốn VI states preflight. Trên candidate mới, chọn local thất bại và giữ managed, nên không ghi là đã reach trạng thái uncertified trên backend mới. |
| 4. Dialog/focus | **PASS frontend delta** | Native UIA nhận dialog có tên từ heading. Tab cuối → đầu, Shift+Tab đầu → cuối được kiểm tra tại Normal Dark/VI và Narrow Dark/EN, focus ring rõ. Escape trả trigger; Space sau Escape mở đúng menu, kể cả Narrow. role=dialog/aria-modal=true/aria-labelledby đối chiếu source mới và dist bundle; UIA không xuất raw HTML attributes, nên không tuyên bố đã đọc các attribute qua DOM runtime. |
| 5. Red fetch banner | **PARTIAL / lỗi thao tác còn tái hiện** | Không thấy raw “Failed to fetch” flash khi reopening; loading/registry vẫn hoạt động. Nhưng candidate mới chọn C++ local hai lần đều có banner đỏ **“Không thể tải cấu hình toolchains”** và file preferences vẫn managed. Code đang dịch error này tại ToolchainManager.tsx:104; không coi đổi wording là đã sửa lỗi API. |
| 6. Shutdown warning | **PASS lượt delta** | Cả preflight lẫn candidate đều Alt+F4, app exit 0 và sidecar code 0; không tái hiện warning 10060 ở hai lượt này. Hậu kiểm 0 process và 0 JudgeDesk.Run.*. Không suy rộng thành mọi shutdown/fault scenario. |

### Finding cần trả Antigravity

**P1 — Chọn C++ local thất bại trên đúng staged sidecar mới.** Repro: mở native từ dist mới → menu Ready → F6 → chọn C++ “Cục bộ (đường dẫn)” với path đã lưu `C:\msys64\ucrt64\bin\g++.exe`. Banner đỏ “Không thể tải cấu hình toolchains”; radio/file preferences vẫn managed. Escape/F6 reopening bỏ banner, nhưng chọn lại thất bại lần thứ hai. Không bấm Freeze/Self-Test hay thay bảo mật.

Bằng chứng: [lần 1](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify/candidate-normal-dark-vi-red-load-error.jpg), [lần 2](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify/candidate-normal-dark-vi-red-load-error-reproduced.jpg), [log candidate](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify/native-candidate.log). Caller cần điều tra: [useToolchains.ts:351](D:/Minh/Code/judgedesk/src/features/toolchains/useToolchains.ts:351), `PUT /api/toolchains/profiles/cpp-legacy-v1/preference`, xử lý message tại [ToolchainManager.tsx:104](D:/Minh/Code/judgedesk/src/features/toolchains/ToolchainManager.tsx:104). Chưa xác định request lỗi tại PUT hay refresh; không kết luận root cause CORS/token/sandbox.

OPTIONS probe không token trên candidate trả **204**, allow-origin localhost:5173, allow-methods có PUT và allow-headers có content-type/x-judgedesk-session; [receipt](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify/cors-options-probe.json). Đây chỉ là preflight control, không chứng minh browser request thực tế hoặc authenticated mutation thành công.

Leg preflight còn có toast “Không thể kết nối dịch vụ chấm bài” khi mở menu; F6 sau đó vẫn tải được và menu lại Ready. Anonymous HTTP control trên port 58268 trả 401 trong 116ms, process vẫn chạy. Không dùng toast ở backend cũ để quy lỗi cho candidate mới. Candidate có warning manifest download timeout riêng; nó là warning danh mục gói, không chứng minh lỗi session.

### Delta hygiene

- Dark/VI được khôi phục qua UI; compiler preferences và sidecar debug được hoàn trả nguyên byte. **69/69 source baseline files khớp**, không sửa runtime source hoặc native-executor/crates, không git reset/stash/clean/checkout.
- **0** process themis-v2/server/judgedesk-executor/judgedesk-native-executor và **0** thư mục `%LOCALAPPDATA%/Packages/JudgeDesk.Run.*` sau cả hai phiên.
- Frozen executor vẫn **964096 bytes**, SHA-256 **fd2c06d8c0b9baaa24051c9044e4166904d7f43459899db54d3019dc69eb2b24** ở target-specific, staged và bản debug executor. Không rebuild/ghi đè executor, không tạo snapshot MSYS2.
- `npm run check:fast` **PASS**, `git diff --check` **PASS**; không rerun full/native gates trong observation-only delta.
- [Delta receipt](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify/hygiene-receipt.json), [gate results](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify/gates.json), [35 ảnh delta với hash và backend identity](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/screenshots.md).

Lượt tiếp theo cần bảo đảm debug/server.exe được stage từ đúng candidate mới trước khi nghiệm thu; bản debug cũ đã được hoàn trả để giữ trạng thái đĩa ban đầu của người dùng. Tránh nhầm khác biệt hai sidecar thành bằng chứng runtime của cùng một build.

## 6. Focused delta re-verify 2 — 2026-10-14

> Historical candidate FA52639B…; latest focused verdicts and P1 closure are in Section 7.

**Gate UI 1 FAIL; Gate UI 2 PARTIAL.** Lỗi chọn Local ở mục 5 không tái hiện (3/3 thành công), nhưng chưa đóng Finding P1 vì lỗi chiều Local → Managed và toast kết nối vẫn quan sát được. Gate UI 3 giữ PASS trước đó, **không chạy lại**; mọi gate macOS **NOT_RUN**. Không rebuild, sửa runtime source hoặc bấm Freeze/Self-Test/install/uninstall.

### Candidate và kết quả Computer Use

Phục vụ dist bằng đúng `npx vite preview --host localhost --port 5173 --strictPort`; mở `src-tauri/target/debug/themis-v2.exe`, thao tác bằng `@oai/sky`. Hai sidecar debug/staged cùng **95366656 bytes**, SHA-256 **fa52639b079c42136dcbcef7a5dbc28b499b3bb55355f62ffb1153ca7270f0e8** trước/sau test. Bundle `index-CZa5g4HL.js`: **da452821a27c324597b27446c1ce52179cc3d08cfec1ce90381bef81c8e7b672**. Shell hash giữ **067cc6cc70c43f378d588552950fe9cfbcc4148c4698e88ebdbc687defc13dbb**. Log xác nhận build **2026-10-14T07:51:14.270Z**, backend **127.0.0.1:54842**; không có mismatch hai sidecar như lượt trước.

| Cấu hình | Managed → Local | Local → Managed / status |
|---|---|---|
| Normal Dark/VI, frame 1536×792 | **PASS**, lưu local_path đúng MSYS2 path; “Chưa khả dụng”, giải thích freeze_required và nút Freeze; không banner lỗi | **FAIL lần đầu**: banner “Không thể tải cấu hình toolchains”, radio/file vẫn Local. Escape → F6 → chọn Managed lại **PASS**, menu G++/Python Ready, không toast |
| Normal Light/EN, frame 1536×792 | **PASS**, lưu local_path, “Not available”, chú thích và nút Freeze rõ | Managed **PASS**. Khi đổi VI → EN trước thao tác, menu Checking và toast **Cannot Connect to Grading Service** xuất hiện; mở lại status sau Escape phục hồi Ready và toast tự xóa |
| Narrow Dark/VI, client 960×600, frame 962×631 | **PASS**, lưu local_path, badge/chú thích đúng. Nút Freeze đọc đủ sau cuộn ngang bảng | Managed **PASS**, Escape đóng, menu G++/Python Ready không toast |

Nguồn gọi PUT đối chiếu tại [useToolchains.ts:351](D:/Minh/Code/judgedesk/src/features/toolchains/useToolchains.ts:351). Thành công xác minh qua UI **và file preferences thực sự lưu**; không capture trực tiếp HTTP status/response hay token. Tổng **3/3 chọn Local thành công**, **3/4 chọn Managed thành công** (gồm retry sau lỗi). Không coi badge “Chưa khả dụng” của Local chưa chứng nhận là lỗi API hoặc fallback.

Nhãn thực tế: **“Cục bộ (đường dẫn)” / “Local (path)”**, **“Do JudgeDesk quản lý” / “Managed by toolchain”**, nút **“Đóng băng cho kỳ thi” / “Freeze for contest”**; khác wording “Freeze & Certify” trong yêu cầu nhưng đúng workflow đã chấp nhận ở mục 5. Không bấm nút. Menu tự đóng khi F6; native UIA tiếp tục nhận named dialog, Escape trả trigger. Semantic/focus và ma trận 8 tổ hợp giữ bằng chứng mục 5, không rerun trong lượt này.

### Finding còn mở

**P1 — Lỗi kết nối/API vẫn thoáng qua trên candidate đồng bộ.** Chiều Local → Managed lỗi **1 trong 4 thao tác**, tại Normal Dark/VI: controls bận rồi banner đỏ; preferences vẫn local_path. Escape/F6 + thử lại lưu Managed thành công. [Ảnh lỗi](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-2/normal-dark-vi-managed-return-error.jpg), [preferences sau lỗi](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-2/normal-dark-vi-managed-preferences.json). Caller PUT/refresh: [useToolchains.ts:351](D:/Minh/Code/judgedesk/src/features/toolchains/useToolchains.ts:351); dịch error: [ToolchainManager.tsx:104](D:/Minh/Code/judgedesk/src/features/toolchains/ToolchainManager.tsx:104). Chưa xác định pha HTTP lỗi hoặc root cause; không suy đoán cache/CORS/session token.

[Toast EN sau đổi ngôn ngữ](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-2/normal-light-en-connection-toast.jpg) vẫn có thật. [Menu phục hồi](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-2/normal-light-en-ready-recovered.jpg) cho thấy toast tự xóa sau status refresh thành công, không dismiss. Anonymous control GET /api/toolchains trả **401 trong 151ms**, chứng minh backend phản hồi, không chứng minh authenticated request. Không đo lại claim prewarm 7ms/keep-alive timing trong lượt UI này.

### Evidence và hygiene

**19 JPEG mới** và AX tree, hashes tại [screenshots.md](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/screenshots.md). Manifest gốc hợp nhất **103 ảnh** (49 + 35 + 19), giữ identity từng leg; [manifest lượt này](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-2/screenshots.json). [Native log](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-2/native.log), [observations.json](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-2/observations.json).

- Alt+F4: **native exit 0, sidecar code 0**. Preview dừng Ctrl+C. **0** process app/server/executor và owned WebView; **0** thư mục `%LOCALAPPDATA%/Packages/JudgeDesk.Run.*`.
- **dark / VI**, toolchains.json nguyên byte SHA-256 **e0119a9bc6d250bf41c7056b8f96e13db7def37208d9819a3df23554419d6e5f**, C++ **mode: managed**. Hash sau thao tác UI đã khớp backup, không cần ghi hoàn trả.
- **79/79 source baseline files khớp**, 0 mismatch. Không sửa native-executor/crates, không reset/checkout/stash/clean; không chạm hai sidecar, source/dist.
- Frozen target-specific/staged/debug executor đều **964096 bytes**, SHA-256 **fd2c06d8c0b9baaa24051c9044e4166904d7f43459899db54d3019dc69eb2b24**.
- `npm run check:fast` **PASS**, `git diff --check` **PASS**. [Hygiene receipt](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-2/hygiene-receipt.json), [gates.json](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-2/gates.json).

## 7. Focused Delta Re-verify 3

**Windows focused verdict: Gate UI 1 PASS; Gate UI 2 PASS.** The two transient failures from Section 6 were not observed on this candidate. Gate UI 3 retains its earlier PASS and was not rerun. Gate UI 4 below means clean teardown/hygiene, previously documented in Section 4; it passed this run. macOS remains **NOT_RUN**.

### Gate Summary Table

| Gate | Verdict | Evidence and scope |
|---|---|---|
| Gate UI 1 — Native session / HostStatusMenu | **PASS** | Normal Dark/VI language VI → EN → VI and theme Dark → Light → Dark stayed Ready with Judge enabled: [#109](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/normal-dark-en-language-ready.jpg), [#110](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/normal-dark-vi-language-return-ready.jpg), [#111](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/normal-light-vi-theme-ready.jpg), [#112](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/normal-dark-vi-theme-return-ready.jpg). Maximized Light/EN language EN → VI → EN: [#118](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/max-light-vi-language-ready.jpg), [#119](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/max-light-en-language-return-ready.jpg). No red connection toast; still Ready after a further 10.5s: [#120](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/max-light-en-delayed-ready-no-toast.jpg). |
| Gate UI 2 — ToolchainManager remaining switching issue | **PASS** | Managed → Local Path → Managed succeeded in both configurations, persisted preferences confirmed. Local C:\Themis\gcc\bin\g++.exe detected as 9.2.0 and correctly remained uncertified: [#106](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/normal-dark-vi-local-themis.jpg), [#115](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/max-light-en-local-themis.jpg). Managed returned Ready without red error/retry: [#107](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/normal-dark-vi-managed-return.jpg), [#116](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/max-light-en-managed-return.jpg). |
| Gate UI 3 — Startup Failure / Retry | **PASS** | Retained earlier IPC-failure acceptance, not rerun on this build: [original alert](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/normal-dark-en-failure-alert.jpg), [original retry busy](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/normal-dark-en-failure-retrying.jpg). |
| Gate UI 4 — Clean teardown / hygiene | **PASS** | [#121 final dark/VI Ready](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/final-dark-vi-ready.jpg) before Alt+F4. Native/sidecar exit 0 and zero remaining processes/profiles proven by [native log](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/native.log) and [hygiene receipt](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/hygiene-receipt.json), not inferred from a screenshot of a closed app. |
| macOS, all gates | **NOT_RUN** | Mac offline; Windows evidence does not change macOS verdicts. |

### Candidate, observations and limits

No rebuild. Served existing dist using `npx vite preview --host localhost --port 5173 --strictPort` and launched the real `src-tauri/target/debug/themis-v2.exe` (app.exe absent). Both debug/staged sidecars SHA-256 **2386a4ed8a9a4bfd9329ae496c53e9ed9abdb45bfd89f0408817bdc0a5346cd2**, **95369728 bytes**, unchanged after observation. Frontend `index-CfJZdLCL.js`: **5faa57be12f46c9e586fdbd08a135101b8edb903a53015a1a2ae7d911f4c1731**. Startup log: build **2026-10-14T09:17:31.777Z**, backend **127.0.0.1:56828**.

Normal was **client 1280×800 / frame JPEG 1282×831**; Maximized was **frame 1536×792**. Used the existing anonymous fixture (Audit_01, four problems) to make Judge enabled; no judging or archive save. The original stored local path was MSYS2, so the requested Themis path was applied using the UI's “Use this path” action before the Normal return to Managed.

Both round trips passed without red load/Failed to fetch banners. Managed was visibly Ready in the first settled capture at **867ms Normal / 880ms Maximized**, measured from input through capture, not HTTP/server latency. Background discovery may still show a blue progress notice while the Managed badge is Ready. Opening the status menu initially showed a brief Checking state while refreshing; **language/theme toggles from stable Ready did not reset it**, and Judge remained enabled in the immediate and settled observations. No red toast was observed during these checks or the delayed capture. This is point-in-time native Computer Use evidence, not continuous video/network tracing; no claims about exact request counts, forced socket failures, or probe-process counts.

Finding P1 is **closed within the requested focused scope** on this candidate. No new UI/accessibility finding. Previous semantic/focus and broad matrix results are retained; no eight-combination matrix, freeze, self-test, uninstall/install, or Gate UI 3 rerun. Correction to request context: existing screenshot #99–#102 show Narrow managed/local switching, not an uninstall/install cycle, and #103 is a Ready menu; those historical records are preserved.

### Hygiene and evidence receipt

- No stale app/backend/executor processes before launch; after Alt+F4, **0** app/themis-v2/server/judgedesk-executor/judgedesk-native-executor and owned WebView processes, **0** JudgeDesk.Run.* directories. Native and sidecar **exit 0**; preview stopped with Ctrl+C.
- Restored **dark / VI** through UI. Restored toolchains.json atomically, byte-for-byte: original/final SHA-256 **e0119a9bc6d250bf41c7056b8f96e13db7def37208d9819a3df23554419d6e5f**, C++ mode managed, original MSYS2 path preserved.
- **80/80 source baseline files match**, no runtime source/binary edits, no destructive Git commands. Frozen executor remains **964096 bytes**, SHA-256 **fd2c06d8c0b9baaa24051c9044e4166904d7f43459899db54d3019dc69eb2b24**.
- `npm run check:fast` **PASS**; `git diff --check` **PASS**. [Gate results](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/gates.json).
- **18 new native JPEG screenshots #104–#121**, unchanged pixels, with SHA-256 and AX trees: [screenshots.md](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/screenshots.md), [run manifest](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/screenshots.json), [observations](D:/Minh/Code/judgedesk/artifacts/native-ui-acceptance-2026-10-14/delta-reverify-3/observations.json). Root JSON manifest now contains **121 screenshots** with original evidence preserved.
