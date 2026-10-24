# JudgeDesk Linux — baseline build và nghiệm thu Core, 22/10/2026

## Phạm vi

Thực hiện bước 1 (baseline Ubuntu 22.04) và chuẩn bị/kiểm thử trong khả năng của bước 2 (nghiệm thu Linux). Chưa triển khai Full, bump version, commit, push hoặc phát hành. Giữ các thay đổi trước đó của Antigravity và Codex.

Mục tiêu phân phối vẫn là Ubuntu 22.04 trở lên. Build host được cố định ở Ubuntu 22.04.5, GLIBC 2.35; Ubuntu 24/26 và Fedora là môi trường kiểm thử runtime. Đây cũng là hướng dẫn của [Tauri về baseline AppImage](https://tauri.app/distribute/appimage/#limitations).

## Source và artifact

Snapshot có 1.004 file từ checkout hiện tại, bao gồm thay đổi chưa commit. SHA-256 của manifest source: `6dcb22a7689f56ea30e6862268fb82e9d5cbd37ba77ba43287cab5fe94ff9a5b`.

Build number: `qa-linux22-6dcb22a7689f56ea`. HEAD làm tham chiếu: `e70dcbfb7cae54df5ab28cc5f88cdd1dd67c305f`; `sourceState=dirty`. Snapshot được xác minh lại từng file trước build. Frontend được build mới từ dependency Linux cài bằng lockfile; không dùng `dist/` hoặc `node_modules` Windows. Node 24.19.0, npm 11.17.0, Rust 1.97.1, Tauri CLI 2.12.0.

Các cải tiến tiếp theo chỉ trong harness QA và tài liệu được lưu riêng với evidence; không thay đổi binary ứng dụng đã đóng dấu snapshot. Artifact QA cũ và metadata được sao lưu trước build, không dùng lẫn làm kết quả bản mới.

## Gate bổ sung

- Build release từ Ubuntu 22.04; từ chối host mới hơn trước khi đóng gói.
- Giải nén DEB/RPM/AppImage cuối, tìm mọi regular file theo magic ELF, không dựa vào đuôi file. Kiểm tra cả runtime ngoài squashfs của AppImage.
- Đọc phần **version needs**, không nhầm version exports thành requirement. Từ chối GLIBC mới hơn 2.35, ABI như `GLIBC_ABI_DT_RELR`/`GLIBC_PRIVATE`, ELF hỏng và cây không có ELF.
- Mỗi report có đường dẫn, SHA-256 và requirement từng ELF. ELF static không có version needs được chấp nhận khi `readelf` đọc thành công.
- Smoke acceptance có thể gắn với hash installer và build number kỳ vọng. DEB/RPM kiểm tra payload đã cài khớp installer; AppImage phải mở đúng file đã kiểm tra hash.
- Từ chối Python tối ưu (`-O`/`PYTHONOPTIMIZE`) để assertions không bị vô hiệu hóa.
- CI Linux chạy regression đóng gói; không thêm npm dependency hoặc Cargo crate.

## Bằng chứng trước sửa và regression

AppImage build Ubuntu 24 cũ: 180 ELF trong payload, tối đa `GLIBC_2.38`; gate mới từ chối. Runtime ngoài AppImage được kiểm tra riêng. Kết quả này chứng minh kiểm tra ba executable cũ đã bỏ sót dependency.

Bộ fixture linker thật có năm test: thư viện lồng sâu không đuôi file, phân biệt needs/exports, requirement mới và ABI đặc biệt, ELF hỏng/cây rỗng, ELF static. Regression thêm từ chối hash sai, AppImage launch path khác và Python tắt assertions; các test bảo vệ Scratch và stage/repair vẫn được giữ.

Review độc lập vòng đầu chỉ ra các thiếu sót về baseline/ABI, source frontend, ràng buộc artifact và Python assertions. Đã xử lý các finding đó. Review lại sau sửa không chạy được vì giới hạn sử dụng; không coi lượt đó là review hoàn tất. Tiếp tục tự review và kiểm tra runtime/hồi quy; không gọi mô hình khác theo lựa chọn của người dùng.

## Nghiệm thu máy thật

Kiểm tra trên Ubuntu 22.04 mặc định phát hiện thêm hai điều kiện chưa được bộ cài tự chuẩn bị:

1. `user@.service` của systemd 249 chỉ có `Delegate=pids memory`, thiếu CPU. Tài khoản QA UID 2200 được thêm drop-in **riêng UID này** với `Delegate=cpu memory pids`; không đổi chính sách của tài khoản khác. Lần restart đầu có lỗi cgroup tạm thời; start sau đó thành công. Không bỏ yêu cầu controller trong executor.
2. Bubblewrap 0.6.1 trong kho Ubuntu 22.04 chưa có `--size`; self-test trả `bwrap: Unknown option --size` và `ready=false`. Tùy chọn này [được thêm từ upstream 0.7.0](https://github.com/containers/bubblewrap/releases/tag/v0.7.0). Để tách ABI ứng dụng khỏi prerequisite host, QA dùng build Bubblewrap 0.12.0 từ [release upstream](https://github.com/containers/bubblewrap/releases/tag/v0.12.0), archive pin `9760d007363e3abba7c747489910f9f82d9fca53ba3bd3282e396fa3c97a3314`. Bản hệ thống gốc được giữ bằng `dpkg-divert`; helper QA không setuid, không dùng cờ nới sandbox, không được nhúng vào installer hiện tại.

Do đó **baseline ABI 22.04 và trải nghiệm cài sạch là hai tiêu chí khác nhau**. Cần thiết kế cách cung cấp Bubblewrap phù hợp và chuẩn bị CPU delegation trong bước cải thiện installer; không đánh dấu phần này đã sửa bằng việc cấu hình môi trường QA. Đây là việc cần làm trước mục tiêu Full “mở ra dùng ngay”.

Một probe thử chạy executor trực tiếp thiếu process-tree guard đã bị từ chối như thiết kế; sau đó harness dùng đúng guard/parent contract. Không sửa hoặc bỏ guard để chạy test.

WSL kiểm chứng được userspace, dependency, sandbox, compile/link/run và vòng đời tiến trình. Nó không thay thế GPU/Wayland/session trên máy tester. Fedora 44 WSL bổ sung bằng chứng cài RPM trên userspace Fedora; không gọi đó là nghiệm thu Fedora desktop vật lý.

Máy tester chỉ cần mở AppImage mới ở đồ họa mặc định, chấm một bài C++ và một bài Scratch. RPM là lượt thêm nếu bạn ấy đang có Fedora và thuận tiện. Không yêu cầu cài distro mới, quay video, thu toàn bộ cấu hình hoặc tự sửa lỗi. Không có công cụ/kênh được cấp để Codex trực tiếp vận hành máy tester hoặc gửi tin cho bạn ấy.

## Kết quả đã hoàn tất

| Kiểm tra | Kết quả |
|---|---|
| DEB / RPM | Mỗi gói có 4 ELF, requirement tối đa GLIBC 2.34: PASS |
| AppImage payload | 177 ELF, requirement tối đa GLIBC 2.35: PASS |
| Runtime ngoài AppImage | 1 ELF static, không có GLIBC version needs: PASS |
| Scratch trong cả ba installer | Trùng byte với bản pin, bootstrap 0.1.7: PASS |
| Ubuntu 22.04 DEB + AppImage | Mỗi gói: 6 diagnostic, 6 bài AC, native drain và scope rỗng; **sau chuẩn bị CPU delegation/Bubblewrap như mô tả ở trên** |
| Ubuntu 24.04 DEB + AppImage | Mỗi gói: 6 diagnostic, 6 bài AC và shutdown sạch |
| Ubuntu 26.04 DEB + AppImage | Mỗi gói: 6 diagnostic, 6 bài AC và shutdown sạch |
| Fedora 44 RPM + AppImage | RPM cài qua `dnf`, tự kéo compiler/static libraries/Bubblewrap; mỗi gói 6 diagnostic, 6 bài AC, shutdown sạch |
| Windows `npm run check:full` | Exit 0; 9/9 bước Rust fmt/clippy/test; 973 server/unit test (963 PASS, 0 fail, 10 conditional skip có sẵn); 67 fixture ở từng tier parity; version lockstep 1.6.0 |
| Regression đóng gói cuối | PASS: 5 test ELF bằng linker thật, bảo vệ/stage/repair Scratch, từ chối hash/path sai và Python tối ưu |
| GUI/GPU máy tester; Fedora desktop/SELinux thật | Chưa nghiệm thu; không suy ra PASS từ WSL |

Các run đều kiểm tra đúng SHA-256 installer và `status.build.buildNumber` kỳ vọng. Hai lượt negative control trên Ubuntu 24/26 từ chối bộ cài mới khi executable cũ vẫn đang được cài, trước khi thay bằng candidate. Các biến workaround đồ họa được bỏ ở launch; không ép X11, không tắt DMABUF/compositing, không bật software rendering, không dùng `APPIMAGE_EXTRACT_AND_RUN` trong acceptance. FUSE runtime được chạy bình thường trong WSL có `/dev/fuse`.

Log WSL vẫn có cảnh báo Mesa/ZINK; không dùng việc backend/chấm hoạt động để xác nhận pixel rendering. Tất cả file test lỗi trung gian được giữ riêng, không tính PASS.

## Các lỗi của công cụ QA được sửa trong lượt kiểm thử

- Ubuntu 22.04 systemd dùng cờ `--kill-who=all`, chưa có `--kill-whom=all`. Harness dùng cờ tương thích cũ cho các distro.
- Sau khi `systemd-run` kết thúc, runtime/FUSE helper có thể cần thêm thời gian thoát. Lượt AppImage Ubuntu 24 đầu còn một PID ở thời điểm chụp tức thì, rồi scope tự biến mất. Harness đợi tối đa 10 giây cho **toàn bộ scope rỗng**, vẫn từ chối nếu còn PID sau deadline. Native executor phải drain trước khi đóng GUI như cũ.
- `rpm2archive` 4.17 ghi file `.tar` cạnh RPM nếu truyền tên file, khiến tar stdout rỗng. Đổi cả ba caller sang stdin (`rpm2archive --nocompression - < artifact`) để nhận tar stdout trên cả bản cũ/mới. [Source upstream 4.17](https://raw.githubusercontent.com/rpm-software-management/rpm/rpm-4.17.0-release/rpm2archive.c) xác nhận hành vi này. Build đầu đã tạo đủ ba installer nhưng dừng tại post-verification; sau sửa, chạy lại nguyên phần kiểm tra và staging của builder, không biên dịch lại binary hay nén lại payload không đổi. Final verification/staging exit 0.
- Hai lượt đọc candidate đồng thời từ filesystem Windows lỗi `ENOMEM` trước khi mở app. Bản sao trên filesystem Linux, cùng hash, chạy tuần tự thành công; không sửa logic ứng dụng để xử lý hiện tượng hạ tầng này. Một lượt Fedora AppImage chưa mở app vì thư mục QA do root tạo; sửa owner riêng thư mục đó trước khi chạy lại.

## Artifact QA để gửi

| File | SHA-256 |
|---|---|
| `JudgeDesk_1.6.0_amd64.deb` | `f2f4653c4142a630f795bc40b1d09afb47e5431041062c1d8a547a3657c92a54` |
| `JudgeDesk-1.6.0-1.x86_64.rpm` | `49f3a504e1ee1bc9dd3c26c3b373a454982f8f8db04fbaa8bd1942416e26fdc2` |
| `JudgeDesk_1.6.0_amd64.AppImage` | `97b08af0db644578b4e72c7cde9b59744e240905fb638dfd21db928cbddd3e6b` |

Thư mục chia sẻ: `C:/Users/mon/Downloads/JudgeDesk-Linux-QA-20261022/`; có installer, checksum, build identity và `README.md` ngắn cho tester. Chỉ cần gửi AppImage + hướng dẫn; RPM thêm nếu đang test Fedora. Chưa gửi tin, upload hoặc phát hành thay người dùng.

Evidence: [manifest/hash/ELF](../../artifacts/linux-baseline-20261022/final-artifacts.json), [full gate](../../artifacts/linux-baseline-20261022/windows-full.log), [gate và staging cuối](../../artifacts/linux-baseline-20261022/verify-and-stage-final.log), [thư mục các lượt runtime](../../artifacts/linux-baseline-20261022/). Bản QA cũ ngày 21/10 được giữ trong `previous-ubuntu24-artifacts/`.

Bước 1 đã chốt baseline ELF và kiểm chứng runtime với prerequisite minh bạch. Bước 2 đã có bộ file và kiểm chứng nội bộ; vẫn chờ người dùng gửi tester và nhận xác nhận GPU/session máy thật. Chưa đủ điều kiện khẳng định Core cài mặc định trên Ubuntu 22.04 là dùng ngay, hoặc AppImage chạy trên mọi distro. Trước Full cần xử lý hai prerequisite sandbox nói trên và khép nghiệm thu máy thật.
