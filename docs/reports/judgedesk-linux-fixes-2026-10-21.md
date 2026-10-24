# JudgeDesk Linux — điều tra và sửa lỗi ngày 21/10/2026

## Phạm vi và nguồn

Làm việc trên source v1.6.0, HEAD `e70dcbfb7cae54df5ab28cc5f88cdd1dd67c305f`, có các thay đổi chưa commit của Antigravity. Các thay đổi đó được giữ lại; bản diff ban đầu được lưu riêng trong thư mục tạm trước khi sửa. Không bump version, commit, push hay phát hành. Các installer cùng tên v1.6.0 trong lượt này là **bản QA nội bộ**, phân biệt với release cũ bằng SHA-256.

Bản tester quay có build identity `19c7a60d728…`, `sourceState=dirty`; vì vậy không mặc định coi nó trùng hoàn toàn tag v1.6.0. Các phần packaging/compiler liên quan đã được đối chiếu source.

## Những vấn đề đã xác định

| Vấn đề | Bằng chứng và mức chắc chắn | Sửa tại gốc |
|---|---|---|
| AppImage trắng cửa sổ, `EGL_BAD_PARAMETER` | Log tester chứng minh backend Rust lên, WebKit/EGL lỗi. Tester chạy được khi thêm **cả** `LD_PRELOAD` và `WEBKIT_DISABLE_DMABUF_RENDERER`; chưa tách được tác dụng từng biến. Tauri upstream có bản sửa đúng nhóm lỗi này. | Pin CLI 2.12.0, dùng bundler/linuxdeploy/GTK plugin mới, cô lập cache công cụ theo CLI. Không ép X11, tắt compositing hay DMABUF trong app. |
| GLib/GVFS `g_variant_builder_init_static` | Log cho thấy module GIO từ hệ thống nạp cùng thư viện trong AppImage không tương thích ABI. Chưa có tái hiện trên Ubuntu 26.04.1/Fedora thật để khẳng định bản sửa đồ họa đã khép hoàn toàn lỗi này. | Cập nhật bộ đóng gói như trên; kiểm tra artifact và yêu cầu xác nhận ngắn trên máy tester. Không thêm workaround toàn cục cho hệ thống. |
| Scratch `pkg/prelude/bootstrap.js` invalid token | Tái hiện được: executable nguồn chạy `--version=0.1.7`; executable trong AppDir cũ tăng **4096 byte**, bootstrap chết giống tester. `patchelf --set-rpath` làm lệch offset payload mà `pkg` nhúng trong executable. `NO_STRIP` không chặn việc sửa RPATH. | Luôn kiểm tra archive pin; phục hồi executable từ ZIP đã xác minh; chỉ bảo vệ thao tác sửa RPATH trên đúng Scratch payload. Các ELF khác vẫn được xử lý bình thường. So byte và chạy bootstrap từ DEB/RPM/AppImage sau đóng gói. |
| Quản lý báo có compiler nhưng chấm CE | Probe cũ chỉ tạo object `-c` trên host; chưa chứng minh linker/static libraries hay chạy sandbox hoạt động. Test wrapper vẫn tạo object nhưng hỏng linker đã tái hiện sự lệch này. | Linux readiness phải compile/link rồi chạy probe trong executor sandbox, cùng đường compile thực tế và đúng selection. Cache có invalidation; diagnostics làm mới trạng thái UI. Khi môi trường hỏng, session trả JE thay vì gán lỗi CE cho bài nộp. |
| Compiler ngoài `/usr` không thấy trong sandbox | Compiler mount trước đây không cấp root cài đặt đã chọn, trong khi runtime có cấp. | Dùng grant root đã validate cho compiler và runtime. Giữ PATH của compiler trước `/usr/bin`, `/bin` để gọi assembler/linker, không đổi compiler đã chọn. |
| RPM thiếu bộ thư viện static | Source luôn dùng `-static`, nhưng RPM chỉ khuyến nghị compiler và không bắt buộc `glibc-static`, `libstdc++-static`. Đây là lỗi dependency xác định được. **Chưa có nguyên văn CE cũ trên Fedora**, nên không khẳng định đây là nguyên nhân duy nhất của lần lỗi tester. | RPM phụ thuộc `gcc-c++`, `glibc-static`, `libstdc++-static`; probe sandbox bắt được thiếu linker/static libraries trước khi báo ready. |
| Scratch sửa rồi nhưng cache vẫn giữ binary hỏng | Receipt/version/archive hash giống nhau khiến bản preserved và executor cache cũ được dùng lại. Có test tái hiện corruption trên cả hai bản. | So executable nguồn với bản preserved/cache của Scratch Linux; tự phục hồi các bản hỏng. Không ghi đè tùy tiện package/version khác đã được cài có chủ đích. |
| Probe `--version` có thể treo vì pipe của tiến trình con | Wrapper thoát nhưng `sleep` con giữ stdout làm `wait_with_output` chưa kết thúc. Test cũ mất khoảng 3 giây; test mới giới hạn dưới 2 giây. | Linux dùng capture file có giới hạn, deadline và thu dọn process group; giữ đường Windows/macOS hiện có. |
| Backend Node tìm sai tên executor Linux | Bộ phân giải dùng `x64-linux` thay vì `x86_64-unknown-linux-gnu` (tương tự arm64). Tái hiện bằng unit test và Rust/Node boundary thật. | Bổ sung mapping Linux đúng với binary được đóng gói; test x64/arm64 và bộ client hiện có. |
| AppImage truyền thư viện riêng sang công cụ host | Tái hiện thêm trên WSL Ubuntu 26.04: `busctl` host dùng `libsystemd-shared-259` cần `OPENSSL_3.4.0`, nhưng nạp `libcrypto.so.3` cũ từ AppImage. Native health chạy độc lập với môi trường sạch thì ready; AppImage dừng do executor chưa sẵn sàng. | Xóa loader variables `LD_LIBRARY_PATH`, `LD_PRELOAD` tại cả Rust/Node executor launch và probe host Linux; giữ nguyên môi trường đồ họa của UI. Hai test poison-library đã RED rồi GREEN; dùng lại sandbox hiện có. |

Nguồn upstream: [Tauri bundler 2.10.0](https://tauri.app/release/tauri-bundler/v2.10.0/), [CLI 2.12.0](https://tauri.app/release/@tauri-apps/cli/v2.12.0/). Phần release notes nêu rõ sửa EGL với Mesa mới và bỏ ép X11 trên Wayland. Điều này hỗ trợ lựa chọn bản sửa; không thay thế nghiệm thu GPU/máy thật.

## Phản biện và bảo vệ tương thích

Review độc lập chỉ ra việc suy root từ `~/bin/g++` có thể cấp cả HOME cho compiler đọc. Đã thu hẹp inference về `bin` khi root quá rộng, đồng thời executor từ chối HOME, các thư mục cha của HOME và các root chung nguy hiểm. Test bao gồm HOME ở vị trí không chuẩn, nằm trong một thư mục con của root suy ra. Không mở mạng hoặc nới sandbox.

Review cũng bắt quyền thực thi của wrapper patchelf trên checkout Linux mới: build thiết lập `chmod 755` trước khi sử dụng. Các thao tác ngoài payload Scratch vẫn chuyển tới patchelf thật.

Smoke test gói cài thật bắt một lỗi trong bản sửa đầu: trường component `sha256` mới không thuộc schema receipt nghiêm ngặt của executor. Trường này đã được bỏ; receipt giữ schema hiện có. Hash archive pin và so byte cuối artifact vẫn được thực thi. Đây là lý do kiểm tra file trong source chưa đủ.

PCH vẫn đi qua cơ chế hiện có. Readiness compile một chương trình kiểm chứng riêng; không thay compiler, không tắt PCH của bài nộp. Bộ test PCH Linux đã kiểm tra generation, single flight, consumption, identity, corruption và prewarm, kèm benchmark 3 warmup/20 trial.

Thay đổi runtime chính được giới hạn bằng `cfg(target_os="linux")`. Cập nhật CLI đóng gói có phạm vi đa nền tảng, nên cần tiếp tục nghiệm thu installer Windows/macOS trước release. Không có máy macOS thật trong lượt này.

Native source được fingerprint kể cả phần mã Linux khi build Windows. Đã thực hiện **hai clean release build Windows** bằng recipe `/Brepro`, cùng SHA-256 `a7de861154753ab6a05fb455f2e908256d0994d09fe5aec14573b366dad3b182`, 965120 byte. Receipt raw-source và literal boundary pin được refreeze có chủ đích sau review; không bỏ kiểm tra identity hoặc thay kỳ vọng bằng hash động lúc test.

## Môi trường và giới hạn bằng chứng

WSL distro `JudgeDesk-Ubuntu-24.04`, Ubuntu 24.04.5, WSL2/WSLg, systemd user có delegated cgroup. Toolchains kiểm thử: GCC/G++ 13.3, Python 3.12, FPC và JDK do package manager cài, Scratch 0.1.7 từ archive pin. Kiểm tra bổ sung trên distro `Ubuntu` 26.04 có sẵn, với user QA không phải root, GCC 15.2 và Python 3.14.4, FPC/JDK hệ thống. Đây là Linux để kiểm tra packaging, API, sandbox và chấm thật; **không tương đương GPU/driver/session của tester hoặc một máy Fedora thật**.

Launch smoke bỏ các biến `GDK_BACKEND`, `WEBKIT_DISABLE_COMPOSITING_MODE`, `WEBKIT_DISABLE_DMABUF_RENDERER`, `LIBGL_ALWAYS_SOFTWARE`, `LD_PRELOAD`, `LD_LIBRARY_PATH` cho riêng tiến trình QA. Không thay cấu hình đồ họa hệ thống. Log WSL có cảnh báo Mesa/ZINK.

Computer Use nhìn thấy cửa sổ WSLg Wayland nhưng capture lại chứa cửa sổ Codex. Ảnh sai đã bị loại khỏi evidence; không sử dụng để click, không ép X11 để lấy ảnh, và **không công nhận pixel/UI-rendering PASS** từ lượt capture đó. Việc backend/chấm chạy được không chứng minh cửa sổ đã vẽ đúng. Cần một lượt mở bình thường trên máy tester để xác nhận phần đồ họa.

## Cách chạy lại

```bash
# Build: dùng CLI Linux đúng phiên bản lockfile; cần công cụ đóng gói hệ thống.
JUDGEDESK_TAURI_CLI=/path/to/linux/node_modules/.bin/tauri bash scripts/build-linux-release.sh
bash scripts/test-linux-packaging.sh

# Sau khi cài DEB và chuẩn bị sáu toolchain trên host:
bash scripts/verify-linux-deb.sh

# AppImage: chạy đúng artifact, không ép backend đồ họa.
python3 scripts/verify-linux-package.py \
  --app /absolute/path/JudgeDesk_1.6.0_amd64.AppImage \
  --bundle-type appimage --evidence artifacts/linux-appimage-new-run
```

Verifier dùng user data/workspace mới, kiểm tra distribution identity, sáu diagnostic sandbox và sáu kết quả AC bằng JSON thực. Sau API shutdown, đợi executor kết thúc, đóng GUI của lượt QA và xác nhận scope không còn PID, gồm supervisor. Đây là kiểm chứng drain của backend và cleanup sau QA; không phải bài test thao tác nút đóng cửa sổ hay cập nhật app.

## Kết quả cuối

| Kiểm tra | Kết quả |
|---|---|
| Windows `npm run check:full` | PASS, exit 0; fast/type/quality gate, 9/9 Rust fmt/clippy/test bước, server suite, checker parity và version lockstep |
| Server/unit suites trong full gate | 973 test, 963 PASS, 0 fail, 10 conditional skip có sẵn; không thêm skip hoặc hạ gate |
| Checker parity | 67 fixture ở từng tier Node, Rust, C++ và Windows packaged binaries: PASS |
| Linux core full suite | 174 PASS, 0 fail, 0 ignored, 24 nhóm; clippy all-targets sạch |
| Linux native executor | 97 PASS, 0 fail, 0 ignored; fmt/clippy sạch |
| Linux Node executor client | 36 PASS, 0 fail/skip, bao gồm lọc loader environment |
| Packaging regression | PASS: bảo vệ Scratch, phát hiện binary hỏng, sửa stage, từ chối archive sai hash |
| Final DEB + AppImage, Ubuntu 24.04 | Mỗi định dạng: 6 diagnostic sandbox PASS, 6 bài AC, executor drain và scope không còn PID |
| Final DEB + AppImage, Ubuntu 26.04 | Mỗi định dạng: 6 diagnostic sandbox PASS, 6 bài AC, executor drain và scope không còn PID; không truyền workaround đồ họa |
| Final RPM | Build, metadata/dependency, payload/hash và Scratch bootstrap PASS; chưa cài/chạy trên Fedora thật |
| GUI pixel rendering / GPU máy tester | Chưa nghiệm thu; capture WSLg không hợp lệ, cần xác nhận trên máy thật |
| Ubuntu 22.04 AppImage | Chưa đạt điều kiện phát hành của baseline thư viện; xem giới hạn GLIBC bên dưới |

Lượt Ubuntu 26 dùng UID QA 2000 để tránh cgroup/user-manager UID 1000 trùng với distro WSL khác đang chạy. Lỗi user-session `Device or resource busy` trong lần thiết lập QA đầu không được coi là lỗi của JudgeDesk. AppImage trước sửa loader vẫn tái hiện lỗi startup khi chạy dưới user QA tách biệt; bản cuối chạy đủ sáu ngôn ngữ.

Source và artifact cuối được giữ tại workspace, chưa phát hành. File trong `release-assets-linux/`:

| Artifact | SHA-256 |
|---|---|
| `JudgeDesk_1.6.0_amd64.deb` | `5fc2d9eac304afd7ddf2ac02493f54159c3eb377a3ddc3a10b4a055bc2e64ced` |
| `JudgeDesk-1.6.0-1.x86_64.rpm` | `4c2db974bc4fea19ab3832381180d3c9fb16ad740ac60b910a3179b4675b5723` |
| `JudgeDesk_1.6.0_amd64.AppImage` | `723c27dfb38f7ae7fb73454c97b151b3f328fb97f3b037c68211253a9f94f3f9` |

Scratch trong cả ba artifact trùng byte với bản pin: `2b44568b484944841c0c3a0621fd5515f2822fe7ab0820b24e6e35d74d307340`, bootstrap 0.1.7. Các executable chính yêu cầu tối đa GLIBC 2.34 (GUI/executor), 2.28 (Node sidecar).

Evidence chính: [thư mục kết quả](../../artifacts/linux-compat-20261021/), [full gate Windows](../../artifacts/linux-compat-full-final.log), [hash/size installer](../../artifacts/linux-compat-20261021/final-artifacts.json), [Ubuntu 26 AppImage](../../artifacts/linux-compat-20261021/ubuntu26-appimage-final/), [Ubuntu 24 AppImage](../../artifacts/linux-compat-20261021/ubuntu24-appimage-final/). Các thư mục/log thử nghiệm thất bại trước sửa được giữ làm bằng chứng, không được tính PASS.

## Việc để sau

Audit thêm 138 thư viện trong AppImage build từ Ubuntu 24.04 cho thấy một số thư viện cần **GLIBC 2.38**, dù ba executable chính chỉ cần 2.34/2.28. Gate `readelf` cũ của build script chỉ quét ba executable đó, nên **không đủ chứng minh cả AppImage hỗ trợ Ubuntu 22.04 (GLIBC 2.35)**. Đây là giới hạn có thật, không được đổi thông số chuẩn để coi là PASS. Trước phát hành cần build AppImage từ baseline cũ phù hợp và kiểm tra toàn bộ ELF/runtime trên Ubuntu 22.04. Các artifact tại đây là QA nội bộ; không dùng kết quả Ubuntu 24/26 để quảng bá “all distro”. Evidence: `artifacts/linux-compat-20261021/appimage-glibc.json`.

Bản Full chứa compiler/runtime offline, giải nén có manifest/hash và quản lý cập nhật toolchain được hoãn đúng phạm vi đã thống nhất. Các bản hiện tại vẫn là Core. AppImage giúp gom nhiều thư viện ứng dụng; không tự bảo đảm mọi distro, mọi glibc/GPU/kernel, hoặc cung cấp sẵn sandbox service và toàn bộ toolchain.

Hướng dẫn gửi tester: [kiểm tra ngắn bản sửa](judgedesk-linux-tester-recheck-2026-10-21.md). Chỉ cần một lần mở AppImage mới, một bài C++ và một bài Scratch; lấy log khi còn lỗi.
