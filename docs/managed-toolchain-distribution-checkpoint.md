# Managed toolchain distribution checkpoint

Ngày kiểm tra: 2026-07-31.

Đây là checkpoint build/test local cho nhánh
`judgedesk/managed-toolchain-distribution`, chưa phải phê duyệt phát hành công
khai. Product binary được build từ `9e02c7a`; các commit sau đó trong checkpoint
chỉ làm cứng release QA và test scheduling.

## Phạm vi đã khóa

- Registry/UI/submission discovery chỉ công bố C++, C, Python, Pascal/FPC và
  Java.
- Go, Rust, JavaScript/Node.js và C#/.NET vẫn còn trong source catalog để nghiên
  cứu nhưng không xuất hiện trong UI, không được nhận là submission, không có
  trong manifest mặc định và không nằm trong bản Full.
- Windows Full có đúng bốn package: GCC dùng chung cho C/C++, CPython, FPC và
  Temurin.
- macOS Full chỉ phát hành Apple Silicon và có đúng ba package managed:
  CPython, FPC và Temurin. C/C++ dùng Apple Clang của Developer Tools.

## Manifest và archive

- Manifest v2 ký bằng key ID `judgedesk-toolchains-2026-07`.
- Manifest SHA-256:
  `ec45fd3b05c2d278b0ee6eb9796af710f1cbf60f6be259af3b5a46d55c78e7fe`.
- Có đúng bảy package (4 Windows x64 + 3 macOS ARM64); tám checksum gồm bảy
  archive và manifest đều khớp.
- Publish inspector re-extract được ZIP và TAR.GZ trên host khác hệ điều hành,
  giới hạn entry/bytes, từ chối traversal, special file, hardlink, link escape,
  link cycle, tên không portable và collision không phân biệt hoa thường.
- Internal file symlink hợp lệ của CPython macOS được kiểm tra target rồi
  materialize tạm để inspect trên Windows; `installedSizeBytes` vẫn dùng kích
  thước symlink logic của host đích. Full preparation trên Mac đã đối chiếu và
  chấp nhận chính con số đó.

## Artifact local đã xác minh

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Windows Core MSI | 39,849,984 | `dfcf61448f7105ec4897eab1a38995b9d8935318fd795be53d87d82a05e57785` |
| Windows Full MSI | 813,736,924 | `60ee5abba023cd6e1950ee678e26ca2efb0ab7516f1f602cb54084c99c34930e` |
| macOS Core ARM64 DMG | 43,916,057 | `74d4294b1643f13558a9e7ce7cad021d50e726ef478f0dd3fe92ab796a3db206` |
| macOS Full ARM64 DMG | 347,292,991 | `2de89536a713510e133c36cdfa88ec2d4585b8d95c581fec071753f4b84495da` |

Windows MSI được administrative-extract thay vì cài đè app đang dùng. Core
không có thư mục `toolchains`; Full có đủ bốn receipt đúng package ID và giải ra
17.717 file. Packaged sidecar báo đúng commit `9e02c7a`, GCC 14.2.0 và CPython
3.12.13 là managed/submission-ready; LPAC/Job self-test xác nhận network blocked,
filesystem isolated, process tree controlled và memory limit supported.

Hai DMG được build trên Mac M-series thật qua Tailscale/SSH. Core và Full đều là
thin ARM64, ad-hoc signed, giữ JIT entitlement cho SEA sidecar và qua packaged
sidecar/Seatbelt self-test. Full nhận CPython 3.12.13 managed; Core không nhận
Python local là submission runtime. Đây là artifact test local, chưa notarize.

## Correctness và security gates

- Windows full server suite: 317 test, 306 pass, 11 platform skip, 0 fail.
- macOS ARM64 full server suite: 317 test, 309 pass, 8 platform skip, 0 fail.
- Cross-host archive suite: 6/6 trên cả Windows và macOS.
- Packaged Windows Full: 10/10 cho C++14, C11, Pascal, Java, Python, custom
  checker C++/Python và private-file/loopback boundary.
- Packaged macOS Full: cùng matrix 10/10 trên Apple Clang + ba managed package.
- Core/Full sidecar gate kiểm startup token, discovery routes, parent-channel
  EOF, architecture/signature/entitlement và secure-runner health.
- Toolchain Manager automated tests giữ action luôn nhìn thấy, render registry
  theo thứ tự với bốn source radio, không ép wizard lần đầu và không reload
  workspace khi đóng dialog.

## Findings được sửa trong checkpoint

1. Manifest generator trước đây dùng runtime extractor native-host nên Windows
   không inspect được TAR.GZ của Mac. Release-only cross-host extractor đã thay
   thế đường này; runtime installer vẫn chỉ giải định dạng native của nó.
2. Managed compiler vừa giải nén có thể bị antivirus quét, làm C++ checker chạm
   watchdog 30 giây. Compiler budget C/C++ và checker được nâng lên 60 giây,
   Pascal lên 45 giây. Đây là compiler watchdog, không thay đổi TLE của bài thi
   và không làm compile khỏe chạy chậm hơn.
3. Full DMG cold mount có thể mất hơn 5 giây để macOS kiểm chữ ký, và
   `/api/status` có thể trả `DETECTION_IN_PROGRESS` trước khi Apple Clang probe
   hoàn tất. Release smoke gate giờ chờ hữu hạn 30 giây và poll tới trạng thái
   settled thay vì báo sai “missing compiler”.
4. Một lần chạy nhiều test file song song trên Windows gây timeout dây chuyền
   ở executor test harness. `test:server` được chạy tuần tự để đổi khoảng 40
   giây CI lấy tính tái lập; runtime JudgeDesk không bị ảnh hưởng.

## Việc còn lại trước public release

- Manual visual/keyboard QA cho Toolchain Manager và first-run trên Windows lẫn
  Mac; automated UI contract đã pass nhưng chưa thay thế kiểm tra trực quan.
- Clean-machine install/upgrade/repair/uninstall và disk-space/error recovery.
- Windows release signing, macOS notarization/Gatekeeper policy và updater
  artifact signing; không được dùng các local artifact ở trên làm public
  release.
- Codemagic/GitHub release workflow, download/import online từ asset công khai
  và rollback/revocation drill.
- Benchmark lặp trên máy cấu hình thấp và contest corpus lớn trước khi gắn mốc
  release production.

