# Linux Full — implementation và nghiệm thu

Thực hiện từ 22/10 sang 23/10/2026, giờ Asia/Bangkok.

Phạm vi: Linux x86-64, backend Rust, phiên bản ứng dụng 1.6.0. Đây là bản QA
nội bộ; chưa publish, commit hoặc push. Tự phản biện và chạy kiểm thử trong máy
hiện tại, không dùng mô hình bên ngoài và không yêu cầu tester chạy thêm.

## Payload và cách hoạt động

Full chứa đủ sáu ngôn ngữ phát hành qua năm gói:

| Ngôn ngữ | Payload được pin |
| --- | --- |
| C, C++ | xPack GCC 14.2.0-2, binutils và sysroot Ubuntu 22.04 |
| Python | CPython standalone 3.12.13, bản GNU Linux |
| Pascal | Free Pascal 3.2.2, units, linker và sysroot |
| Java | Temurin JDK 21.0.12+8, gồm `javac` và `java` |
| Scratch | scratch-run 0.1.7, giữ nguyên binary upstream |

Installer nén cây resource đã chuẩn hoá; `.deb`/`.rpm` giải nén khi cài,
AppImage cung cấp cây resource trong filesystem của nó. Lần sử dụng đầu,
ứng dụng xác minh rồi giữ bản toolchain trong dữ liệu người dùng và nhập bản
riêng vào cache executor. Không cần tải compiler hoặc gọi `tar` lúc sử dụng.
Không thay đổi preference `none`/đường dẫn local đã lưu của người dùng.

Manifest phân phối, receipt, provenance nguồn, SBOM, notices/giấy phép và chỉ mục
từng file đi kèm. SHA của chỉ mục được pin độc lập trong binary ứng dụng;
receipt hoặc chỉ mục tự sửa không thể tự xác nhận tính hợp lệ. Cache Linux
phân biệt cả digest package, không chỉ version. Windows/macOS giữ tên cache cũ.

Các compiler mới chỉ sẵn sàng sau khi biên dịch và chạy probe thật trong sandbox.
Managed compiler không chuyển sang compiler khác khi gặp lỗi. Native executor,
chính sách zero-network và giới hạn tài nguyên không được nới lỏng bởi Full.

## Những giả định đã kiểm tra và sửa

- **GCC archive chưa đủ:** thêm sysroot/linker closure. Giữ libc động ở baseline;
  chỉ liên kết tĩnh libstdc++/libgcc cho output C++. Probe `std::thread` phát hiện
  cách liên kết static glibc trước đó có thể abort; cấu hình mới đã chạy được.
- **FPC cần nhiều hơn binary:** thêm units, linker/search paths và sysroot.
  Bài Pascal có `cthreads`, `classes`, `TThread` đã được dùng để kiểm tra thực.
- **Linux có tên file phân biệt hoa thường:** extractor bật chính sách POSIX
  riêng cho Linux; giữ quy tắc cũ của Windows/macOS. Chặn traversal, links thoát
  root, duplicate và quá giới hạn; không nhận archive tuỳ ý từ submission.
- **Resource bundler bỏ thư mục rỗng:** normalizer bỏ thư mục rỗng trước khi tạo
  index; tránh receipt hợp lệ nhưng resource cài đặt thiếu entry FPC.
- **linuxdeploy có thể sửa SDK ELF:** đóng gói desktop trước, thêm SDK nguyên vẹn
  sau đó rồi mới tạo SquashFS. Audit ELF/index cuối cùng cho cả ba format.
- **Core → Full còn Scratch legacy:** chỉ chuyển đổi đúng version/primary-source
  digest với binary giống hệt nguồn Full đã xác minh, và đúng ba file legacy.
  Không chạy binary cũ trước chuyển đổi. Thêm tệp hoặc sửa binary thì giữ nguyên
  thư mục và báo không sẵn sàng; không ghi đè dữ liệu chưa biết.
- **Nhập cache thất bại:** staging, khoá liên process, backup/rename/recovery;
  nguồn và stage được kiểm tra trước khi kích hoạt. Thử hết dung lượng thật
  chứng minh không xoá cây cũ. Cache bị sửa được sửa lại từ nguồn tin cậy.
- **PCH vẫn dùng được:** tạo bằng chính managed GCC trong sandbox. Identity gồm
  compiler, flags, header và digest toolchain; không phân phối PCH dựng trên máy
  build. Ca chấm lặp giữ nguyên metadata và mtime của PCH, kết quả AC.
- **Cache chưa tồn tại:** purge Linux trả về bình thường trước lần import đầu;
  có regression test riêng, không thay đổi các waiver/skip hiện có.
- **`/tmp` có thể là RAM:** vùng executor của Linux Full nằm trong
  `appdata/executor-state/`, kiểm tra owner, mode `0700`, path và symlink trước
  khi dùng. Chỉ đặt `TMPDIR` cho child executor; môi trường UI/host giữ nguyên.
  Dùng lại `libc` đã có trong workspace để gọi `geteuid`, không thêm crate/version.
- **Sandbox từng giả định root ở `/tmp`:** chuyển cache làm probe phát hiện
  synthetic parent ghi được bên trong namespace. Luôn remount `/` và `/tmp`
  chỉ đọc, giữ workspace bind và bounded-temp child mount ghi được. Không bỏ
  probe hay nới sandbox. Candidate `e50cec3097b908ef` bị loại vì ca này.
- **Ghi marker thất bại:** sau khi chép xong vẫn có thể hết dung lượng/inode;
  dọn stage khi ghi completion marker lỗi và giữ nguyên cache cũ. Regression
  test mô phỏng lỗi ghi marker bằng directory collision; cả 4 import tests qua.
- **FPC và đường dẫn dài:** probe ngoài sandbox xác nhận khoảng trắng tự nó
  vẫn chạy được; đường dẫn dài làm FPC không nạp units. Compiler managed nhận
  hai view ngắn `/jd-tools` (chỉ đọc, đúng SDK đã grant) và `/jd-work` (đúng
  workspace đã grant). Đường dẫn host và receipt/digest giữ nguyên. Contract ở
  `shared/linux_sandbox_paths.rs`, được đưa vào native build fingerprint.
  Không áp dụng view compiler cho runtime submission hoặc local compiler.
  Probe FPC thực dưới đường dẫn host >300 byte biên dịch thành công, output `42`.
- **Java và UTF-8:** trace chỉ ra Java runtime tìm `Full ki???m th???` khi
  sandbox clear environment. Mặc định `LANG=C.UTF-8` trong sandbox Linux; giữ
  locale do backend chỉ định. Không sửa locale của hệ thống hoặc của GUI.
  Lượt pilot cuối kiểm tra cùng lúc cả sáu ngôn ngữ và PCH dưới đường dẫn rất dài.
  [FPC mô tả `-Fu` và wildcard](https://docs.freepascal.org/docs-html/user/usersu14.html);
  kết luận về trường hợp lỗi cụ thể dựa trên probe/trace được lưu trong evidence.

- **RPM cài bởi root, chạy bởi user thường:** nghiệm thu candidate `9b6dae6badc9e735`
  bắt được receipt `0600`, nên user không đọc được metadata Full. Sửa tại bước
  tạo distribution resource: directory/executable `0755`, file dữ liệu `0644`,
  loại bỏ special permission bits; giữ executable identity và toàn bộ byte/hash.
  Preflight từ chối resource sai quyền, symlink hoặc special file. Cache runtime
  và receipt trong dữ liệu riêng của user giữ chính sách cũ. Core Scratch dùng
  bước staging riêng đã ghi receipt `0644`; Windows/macOS không chạy bước này.
  Hai regression tests POSIX và ca receipt `0600` trong Full preflight đã qua.

- **Fedora không có đường dẫn libc kiểu Debian:** candidate `ac5eda8c932129b6`
  qua DEB nhưng bài Pascal `cthreads/classes` trên Fedora không link được.
  Probe độc lập tái hiện lỗi khi chỉ dùng `-XR`; thêm `-k--sysroot=/jd-tools/sysroot`
  thì biên dịch và output `42`. Truyền sysroot rõ ràng cho linker tại helper
  managed Linux chung; không thay compiler local hoặc Windows/macOS. Diagnostic
  Pascal managed Linux nay nạp `cthreads/classes` để không báo ready chỉ nhờ RTL
  tối thiểu. [FPC mô tả `-XR` và `-k`](https://www.freepascal.org/docs-html/user/userap1.html).
- **Quyền resource nền từ Windows snapshot:** Dockerfile và header compatibility
  mang `0777` từ DrvFS. Khai báo `0644` cho đúng hai data resource tại Linux build;
  audit cuối kiểm tra toàn bộ cây `/usr/lib/JudgeDesk` trong mỗi installer, chặn
  private metadata, group/world write, special bits và links. Ca regression mới
  thất bại trước sửa rồi qua; tổng ELF gate tests 8/8.

## Nguồn và bằng chứng

Thư mục bằng chứng: `artifacts/linux-full-implementation-20261022/`.
Source freeze: `source-manifest.json`, 1049 file, SHA tập nguồn
`5869f484e19f25262597d8791dcbf1f471a472c28dfaea5a2651e5897d62e99f`.
Build number: `qa-linux-full22-5869f484e19f2526`.
Base commit: `e70dcbfb7cae54df5ab28cc5f88cdd1dd67c305f`, worktree dirty có chủ đích.
Báo cáo nghiệm thu được bổ sung sau khi freeze, không thay đổi code của artifact.

- Candidate trước sửa storage (`4ac8dd2747d7d187`), `deb-ubuntu22-upgrade-green/`:
  đối chiếu SHA installer và từng file đã cài;
  Scratch-first từ Core legacy; sáu diagnostics `sourceMode=managed`; sáu bài AC
  (C++ thread/atomic, Python ssl/sqlite3/ctypes, Pascal thread, Java, C, Scratch).
  Có lưu snapshot cả năm package sau preserve và bản export Excel.
- `pch-before.json` / `pch-after.json` trong run đó: PCH 87,996,160 bytes, lần
  tạo 2536 ms trên máy QA; cùng digest GCC, metadata và mtime không đổi qua hai
  lần chấm C++. Lần chấm lặp 713 ms; đây là một mẫu, không phải benchmark cam kết.
- `legacy-negative-binary/`, `legacy-negative-extra/`: cả hai không sẵn sàng,
  không sinh index mới và giữ nguyên nội dung cũ.
- `import-probe.log`: cache bị đổi byte được nhập lại chính xác; nguồn bị sửa
  bị từ chối trước khi reuse cache; vùng tmpfs riêng 1 MiB gây ENOSPC thực,
  giữ nguyên tệp đánh dấu cây cũ và dọn staging.
- `linux-core-gates-upgrade.log`: 2 support + 3 activation/recovery + 11 integrity
  tests qua, clippy all-targets `-D warnings` qua. `legacy-linux-unit.log`: 2/2.
- `packaging-node.log`: 29/29 focused packaging tests. Normalizer Python 8/8,
  ELF audit tests 7/7 đã qua trước khi rebuild; SDK không đổi ở rebuild này.

Các run lịch sử được giữ nguyên để giải thích lỗi đã phát hiện. Bảng nghiệm thu
cuối bên dưới chỉ dùng các installer thuộc snapshot `5869f484e19f2526`.

- `native-final24.log`: Linux native 95 library + 5 binary tests qua, clippy qua.
  `native-full-home-confirmed.log`: client thật khởi động native executor dưới
  home, đường dẫn `Full kiểm thử`, cả bốn security readiness flags đạt.
- `windows-native-final-build.log`: rebuild executor Windows bằng recipe chuẩn;
  SHA vẫn `a7de861154753ab6a05fb455f2e908256d0994d09fe5aec14573b366dad3b182`,
  size 965120. Cập nhật source pins, giữ nguyên literal identity assertions.
- `windows-full-idle.log`: trước hai sửa cuối về sandbox parent/marker, gate đầy
  đủ qua: Rust 9/9, Node 988 tests (978 pass, 10 existing conditional skips),
  parity và version. Run tải cao trước đó timeout 600s đã được giữ trong evidence;
  không tăng timeout. Gate cuối cùng được chạy lại sau các sửa cuối.
- `windows-full-alias-final.log`: gate đầy đủ qua với shared path contract;
  `check-fast-final-accepted.log` và `executor-freeze-final-accepted.log` kiểm tra
  tiếp sau sửa locale chỉ thuộc Linux, giữ nguyên Windows binary identity.
- `linux-regression-locale-final.log`: native Linux 96 library + 5 binary tests,
  Core Full 11/11, Core Core 11/11 và clippy all-targets qua. Mapping path tests
  3/3 trong `short-path-green.log`; marker activation 4/4 trên Windows.
- `full-core-pilot22-final.log`: đủ C, C++, Pascal, Java, Python, Scratch thực
  sự compile/execute bằng managed toolchains; PCH C++ tạo thành công. Thư mục
  dữ liệu có UTF-8, khoảng trắng và component dài 100 ký tự. Pilot chạy trước
  khi đóng lại installer, không được thay cho nghiệm thu installer cuối.
- `import-probe-final.log`: ENOSPC thực khi chép payload và khi ghi completion
  marker đều giữ cây cũ, dọn stage; nguồn bị sửa bị từ chối, cache hỏng được sửa.
- Hai lỗi của harness được ghi riêng: RPM identity extraction vào `/tmp` thiếu
  chỗ; một run khác đọc installer khi đang copy. Chuyển phần tạm của harness
  vào home, đợi copy và xác minh SHA xong mới chạy. Không đổi `TMPDIR` ở harness
  để che dung lượng cache ứng dụng. Các run lỗi không được tính PASS sản phẩm.

## Kết quả nghiệm thu bộ cài cuối

Build: `qa-linux-full22-5869f484e19f2526`. Cả ba installer được đối chiếu SHA;
DEB/RPM còn đối chiếu từng file đã cài với đúng payload installer bằng user thường.

| Bộ cài / môi trường | Kết quả |
| --- | --- |
| DEB / Ubuntu 22.04.5 WSL đã provision sandbox | 6 managed diagnostics ở phase execution, 6 bài AC; Core Scratch → Full; PCH tạo rồi reuse; export pass/fail; shutdown sạch |
| RPM / Fedora 44 WSL, UID 4400 | 6 managed diagnostics và 6 bài AC, gồm Pascal thread; PCH reuse; export pass/fail; shutdown sạch |
| AppImage / Fedora 44 WSL, UID 4400, namespace chỉ có loopback | Mount FUSE thông thường; 6 managed diagnostics, 6 bài AC; PCH reuse; export pass/fail; **137/137 stress PASS, 0 fail, 0 blocked**; shutdown sạch |

Evidence: `deb-ubuntu22-5869f4-pass/`, `rpm-fedora44-5869f4-pass/`,
`appimage-fedora44-offline-5869f4-netns-pass/`, `final-acceptance-summary.json`.
Các ca stress bao gồm verdict, I/O, Unicode, checker, Scratch và điểm rational.
Không thay expected results, không loại ca stress để đạt kết quả này.

- DEB/RPM: audit 11.112 resource entries bằng UID 2200/4400, tất cả đạt quyền
  machine-wide; cache executor vẫn owner UID của user, mode `0700` trong home.
- AppImage: SDK cache thực 1.549.254.253 bytes, dưới appdata/executor-state;
  không đặt TMPDIR cho toàn bộ GUI/host để che thiếu dung lượng tmpfs.
- Harness offline ban đầu bọc Bubblewrap khiến helper FUSE không dùng được.
  Probe mount bình thường đã qua; fuse3 3.18.3 đã có sẵn, dnf không cài thêm gì.
  Run cuối tạo riêng network namespace rồi hạ xuống UID 4400, bật loopback,
  không có interface/route ra ngoài. Native submission sandbox giữ nguyên.
  Không dùng extract-and-run hoặc graphics flags thay thế để tính PASS.
- Export: trình xem giả lập có chế độ lỗi loader tức thời; workbook và diagnostic
  vẫn được lưu đúng bytes. Chế độ thành công gọi curl hệ thống thực, xác minh
  không nhận loader/GTK paths của AppImage. Đây không phải chứng nhận GUI LibreOffice.
- Final audit: DEB 2.029 ELF, RPM 2.029 ELF, AppImage payload 2.202 ELF; tất cả
  GLIBC ≤ 2.35. Outer AppImage runtime static, không ghi GLIBC requirement.
  Audit cuối cũng kiểm tra quyền resource và content index; reports ở
  `final-elf-baseline/`.
- `windows-full-linker-final.log`: check:full exit 0; Rust 9/9 gate steps,
  Node 990 tests (980 pass, 0 fail, 10 existing conditional skips), parity và
  version 1.6.0 qua. Không thêm skip/waiver hoặc hạ timeout/threshold.
- Linux sau sửa cuối: support tests 3/3; Core lib 11/11; Core all-target clippy
  -D warnings qua; ELF/permission tests 8/8. Native 101 tests đã qua trước các
  sửa Core/packaging cuối; native source không đổi sau đó.
- `post-build-source-verification.json`: đủ 1.049 file khớp source freeze,
  không có drift. Windows executor vẫn SHA a7de861154753ab6a05fb455f2e908256d0994d09fe5aec14573b366dad3b182,
  size 965120. Không cập nhật literal assertions để che khác biệt binary.

Bộ cài ở `artifacts/linux-full-implementation-20261022/installers/`, kèm
README, metadata, QA-build-identity, source-manifest và SHA256SUMS-linux:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| JudgeDesk_1.6.0_full_amd64.deb | 644095170 | `c971f941c3c0d08f71975911baa8c40dcaa771feba31a60e6bb99df9adceb3cf` |
| JudgeDesk-1.6.0-full-1.x86_64.rpm | 557296208 | `36bdbc2a9f7e9fdd64ba47ecdf0976ed07505cbb98ea247616432a95b6c4a23c` |
| JudgeDesk_1.6.0_full_amd64.AppImage | 584038904 | `2a89ada072b6e73a1aa249819478d93311cde69655b378c6fecb874d00b43c8f` |

Installed-size DEB: 1.711.962.112 bytes, chưa tính preserve/cache/PCH.
QA cùng version 1.6.0 cần reinstall khi thay Core bằng Full; filename Full không
làm đổi RPM package identity. Lượt QA RPM dùng --replacepkgs; hướng dẫn ghi rõ
trong README. Chưa thiết kế việc cài đồng thời Core và Full.

## Tự phản biện cuối

- Correctness: phân biệt compile probe tối thiểu với bài có native library/thread;
  Fedora đã bắt được lỗ hổng trong giả định dựa trên Ubuntu. Sửa helper chung, tăng
  diagnostic Pascal managed và giữ cả failed evidence, không sửa expected results.
- Security: SDK phải có index/pin độc lập; cache runtime riêng tư; resource cài toàn
  hệ thống đọc được nhưng không cho group/world ghi. Gate kiểm tra cả output của
  bundler, không chỉ input. Không nới cgroup, seccomp, mount hoặc network policy.
- Platform: sysroot/linker args và probe mới chỉ dùng managed Linux. Resource mode
  được khai báo trong Linux builder. Không thay compiler local, renderer hoặc
  compiler fallback; Windows executor giữ cùng byte identity.
- Maintainability/performance: dùng helper compiler chung cho diagnostics và judge;
  bước kiểm tra quyền nằm ở build/audit, không thêm một lượt walk vào hot path chấm.
  Không thêm npm package hay crate/version mới.

## Giới hạn và điều kiện trước phát hành công khai

- Manifest hiện ký bằng khoá QA tạm, không thay đổi trust store phát hành chính.
  Cần ký bằng thẩm quyền release thật và chốt quy trình phân phối source tương
  ứng/giấy phép của GCC, binutils, glibc, FPC và các thành phần đi kèm trước publish.
  Không có private signing key được lưu vào repository.
- Chứng nhận ELF đặt baseline GLIBC ≤ 2.35. `GLIBC_PRIVATE` chỉ được chấp nhận
  cho link inputs nằm trong sysroot compiler đã đối chiếu index độc lập;
  runtime/desktop ELF không được miễn kiểm tra này.
- Ubuntu 22.04 WSL dùng để QA đã nâng bubblewrap và provision CPU delegation;
  không phải bằng chứng stock Ubuntu 22.04 hoạt động ngay. Full cung cấp ngôn
  ngữ, vẫn cần GTK/WebKit, sandbox/userns/cgroup và graphics stack phù hợp.
  Không tự đổi chính sách bảo mật hệ điều hành để chữa máy thiếu prerequisite.
- AppImage không có nghĩa mọi distro/kernel/driver đều tương thích. WSLg không
  thay thế chứng nhận Wayland/GPU máy thật. Lượt UI trước rebuild đã kiểm tra
  EN/light và sáu dòng ready. Lượt cuối API/GUI process vẫn chạy nhưng công cụ
  chụp WSLg trả sai ảnh cửa sổ với `[WARN:COPY MODE]`; không tính đó là pass
  nghiệm thu VI/dark và không thay renderer ứng dụng để đạt ảnh đẹp.
- Cây toolchain khoảng 1.55 GB; installer/desktop khoảng 1.7 GB khi giải nén.
  Preserve và cache executor tạo thêm bản sao, cộng PCH và file tạm. Cần dự trù
  vài GB cho lần dùng đầu và nhiều hơn khi cập nhật; chưa claim tối ưu footprint.
- Khi phát hành phiên bản SDK Full tiếp theo, giữ pin của các phiên bản đã được
  phân phối mà muốn hỗ trợ. Không bỏ pin cũ rồi tự đổi compiler đã được chọn.
- AppImage tooling hiện lấy type2 runtime từ upstream `continuous`; SHA installer
  cuối có lưu nhưng chưa phải recipe bit-for-bit reproducible. Cần pin cả builder
  tools/runtime trước public release, ngoài việc pin SDK đã thực hiện.
- Không thực hiện chứng nhận runtime macOS trong máy này. Các nhánh platform
  hiện có được bảo vệ bằng test/gate; không đồng nghĩa đã chạy lại trên Mac thật.
