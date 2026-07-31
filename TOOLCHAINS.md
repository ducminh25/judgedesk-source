# Managed toolchains

JudgeDesk phát hành hai biến thể:

- **JudgeDesk Full**: lựa chọn khuyến nghị, có sẵn các compiler/runtime đã kiểm chứng và dùng được offline ngay sau khi cài.
- **JudgeDesk Core (Judger Only)**: nhỏ hơn, cho phép tải cùng các gói đã ký về sau hoặc chọn toolchain local phù hợp.

## Phạm vi release hiện tại

Release này chỉ công bố các ngôn ngữ phổ biến có trong Themis:

| Ngôn ngữ | File | Windows x64 | macOS Apple Silicon |
| --- | --- | --- | --- |
| C++ | `.cpp` | GCC 14.2.0 managed | Apple Clang 17 được hệ điều hành cung cấp |
| C | `.c` | Dùng chung GCC 14.2.0 managed | Apple Clang 17 được hệ điều hành cung cấp |
| Python | `.py` | CPython 3.12.13 managed | CPython 3.12.13 managed |
| Pascal/FPC | `.pas`, `.pp` | Free Pascal 3.2.2 managed | Free Pascal 3.2.2 managed |
| Java | `.java` | Eclipse Temurin 21.0.12+8 managed | Eclipse Temurin 21.0.12+8 managed |

Go, Rust, JavaScript/Node.js và C#/.NET đang được giữ ở source catalog để nghiên cứu và build thủ công, nhưng không xuất hiện trong app, không được nhận là submission và không nằm trong manifest/Full installer của release này.

JudgeDesk không phát hành bản macOS Intel.

## Nội dung bản Full

Windows Full chứa đúng bốn package:

1. `gcc-windows-x64` dùng chung cho C++ và C.
2. `python-windows-x64`.
3. `fpc-windows-x64`.
4. `temurin21-windows-x64`.

macOS Full chứa đúng ba package managed:

1. `python-macos-arm64`.
2. `fpc-macos-arm64`.
3. `temurin21-macos-arm64`.

C và C++ trên macOS dùng Apple Clang thuộc Developer Tools đang được chọn; JudgeDesk không phân phối lại Apple SDK.

## Mặc định tương thích Themis

- C++ dùng C++14 với `-pipe -O2 -s -static -lm -x c++`; Windows giữ stack reserve `66060288`.
- C dùng C11 với `-pipe -O2 -s -static -lm -x c`; Windows giữ stack reserve `66060288`.
- Pascal `.pas` và `.pp` dùng `-O2 -XS -Sg -Cs66060288`. JudgeDesk có thể thêm cờ nội bộ cần thiết để package FPC chạy an toàn sau khi relocate, nhưng không thay đổi chuẩn ngôn ngữ hay giới hạn đề.
- Java biên dịch bằng `javac`; JudgeDesk chỉ thêm thư mục output riêng để bảo vệ và thu thập artifact `.class`.
- Python được thông dịch bằng runtime đã chọn.

## Phát hiện và lựa chọn local

Lần khởi tạo đầu, JudgeDesk chỉ chạy một lượt auto-detect nhanh qua `PATH` và một số vị trí cài đặt quen thuộc; không quét toàn ổ đĩa và không chạy certification nhiều phút. Sau đó người dùng có thể bấm Rescan khi cần.

Mỗi profile có đúng bốn lựa chọn: None, Managed by toolchain, Local (path), Local (auto-detect). Version đúng chưa đủ để được chạy submission: source local còn phải phù hợp với secure runner của nền tảng. Nếu không, app giữ trạng thái Not available và hướng người dùng dùng managed package; không fallback ngầm sang compiler khác.

## Nguồn, tính toàn vẹn và giấy phép

Mỗi package được tạo từ upstream URL cùng checksum cố định, kèm license, notice, source provenance và SPDX SBOM. Manifest v2 ký Ed25519 khóa package ID, version, OS/architecture, component, kích thước và SHA-256. JudgeDesk kiểm tra manifest, archive và receipt trước khi cài hoặc dùng.

Pack built-in và pack tải online là cùng artifact/digest. Pack built-in ở store read-only và không uninstall riêng; pack downloaded nằm trong store per-user và có thể uninstall khi không có batch chấm đang chạy.

Workflow [Build and Publish Toolchains](.github/workflows/toolchains.yml) chỉ build/publish package thuộc phạm vi release mặc định. Một package hoãn lại vẫn có thể được build rõ ID để làm gate phát triển, nhưng không tự đi vào bản Full.
