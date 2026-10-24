# Linux Full — nghiên cứu và thiết kế triển khai

Ngày: 2026-10-22. Phạm vi: nghiên cứu source và metadata upstream; chưa tạo bộ cài Full,
chưa chứng nhận các payload đề xuất. Không yêu cầu tester kiểm thử thêm và không dùng
reviewer/model bên ngoài. Các kết luận dưới đây đã được tự phản biện theo từng giả định.

## 1. Mục tiêu và cách hiểu chính xác

Full Linux hướng tới chạy offline với **C, C++, Python, Pascal, Java và Scratch**,
không yêu cầu người dùng tự cài compiler/interpreter cho sáu profile phát hành này.
C/C++ dùng chung một package, nên có năm package ngôn ngữ chính. Những adapter dormant
khác trong source không tự động trở thành phạm vi Full.

**Có thể đóng gói cả C/C++ và Python trên Linux.** Việc pipeline hiện chưa hỗ trợ
không phải giới hạn của AppImage hoặc của các ngôn ngữ này.

Đối chiếu `server/toolchains/release-scope.ts` tại thời điểm nghiên cứu:

| Ngôn ngữ | macOS ARM64 hiện có trong danh sách managed Full | Linux Full đề xuất |
| --- | --- | --- |
| C/C++ | Apple Clang và SDK từ Xcode/Command Line Tools của máy | GCC, binutils, headers, CRT, sysroot và các thư viện cần thiết đi kèm |
| Python | Python managed đi kèm | Python standalone cùng thư viện chuẩn và extension cần thiết |
| Pascal | FPC managed; đường linker/SDK vẫn có hỗ trợ từ nền tảng Apple trong source | FPC, units và toàn bộ phụ thuộc link cần cho profile đã hỗ trợ |
| Java | Temurin JDK managed | Temurin JDK, gồm cả `javac` và `java` |
| Scratch | Scratch managed | Payload Scratch nguyên vẹn đã kiểm chứng |

Mac không bắt người dùng cài Python riêng theo contract Full hiện có. C/C++ là ngoại lệ
vì thiết kế hiện dùng Apple Clang/SDK. Không áp ngoại lệ đó sang Linux theo suy luận.
Danh sách package và nhánh xử lý trong source là bằng chứng thiết kế hiện tại, không
thay cho chứng nhận từng bộ cài macOS đã phát hành.

Full chỉ loại bỏ việc cài toolchain ngôn ngữ. Kernel, CPU architecture, graphics,
user namespaces, cgroup và các chính sách hệ điều hành vẫn là điều kiện tương thích.
Không quảng bá AppImage là chạy trên mọi distro hoặc thay thế mọi thành phần OS.

## 2. Những phần tái sử dụng và khoảng trống đã xác nhận

- `scripts/prepare-distribution.ts`, `scripts/fetch-toolchain-release.ts` và
  `scripts/package-toolchains.ts` hiện giới hạn các host Windows/macOS.
- `server/toolchains/release-scope.ts` chưa có nhóm `linux:x64`.
  Phải kiểm tra required package set khác rỗng: chỉ mở platform guard sẽ có nguy cơ
  để điều kiện `selected.length === requiredIds.size` chấp nhận một Full có 0 package.
- `server/toolchains/distribution-builder.ts` đã có xác minh signed manifest bằng
  Node crypto, kiểm tra archive hash/size, staging và distribution lock. Nên mở rộng
  cơ chế này thay vì tạo một downloader/format độc lập cho Linux.
- `scripts/extract-toolchain-release-archive.py` có các kiểm tra archive an toàn ở
  thời điểm build. Không được coi việc copy thư mục ở runtime là cùng mức xác minh.
- Rust discovery đã nhận diện tên package Linux, nhưng importer/cache còn dựa nhiều
  vào receipt và existence. `archiveSha256` ghi trong receipt không chứng minh các
  file hiện tại vẫn đúng nội dung archive. Scratch có một số kiểm tra riêng sâu hơn.
- `prepare_compiler_mount` trong `crates/judgedesk-core/src/engine/compiler.rs`
  đi qua nhánh managed compiler cho macOS hoặc Java; Linux GCC/FPC cần được nối vào
  contract managed một cách rõ ràng. PATH Linux hiện có `/usr/bin` và `/bin`:
  compiler đi kèm chưa đủ để bảo đảm không gọi helper của máy.
- Các caller cần audit chung: discovery/status, diagnostics, compiler, runner,
  checker runtime, interactive runner, PCH/prewarm, cache và update handoff.
  `preserve_bundled_toolchains_in` được gọi từ update handoff; chưa có bằng chứng
  rằng lời gọi đó tự cung cấp một quy trình import lần đầu đầy đủ.
- Bộ cài Linux hiện đóng Scratch cùng app và có phụ thuộc ngôn ngữ từ distro.
  Full cần cấu hình riêng; không xóa phụ thuộc của Core hoặc thay semantics lựa chọn
  `local_path`/`none` của người dùng hiện có.

## 3. Nguồn payload: ứng viên, chưa phải phiên bản phát hành đã chứng nhận

Metadata gốc được lưu tại `artifacts/linux-full-research-20261022/upstream-metadata.json`
và `upstream-followup.json`. Chưa tải toàn bộ archive hoặc xác minh payload ELF.
Hash do metadata/checksum upstream công bố phải được kiểm tra lại trên bytes tải về.

| Package | Ứng viên nghiên cứu | Điều phải chứng minh trước khi chốt |
| --- | --- | --- |
| GCC C/C++ | xPack GCC 14.2.0-2 Linux x64 | Closure headers/CRT/sysroot/linker, tính relocatable, ABI, license/source, compile và chạy trong strict sandbox |
| Python | python-build-standalone CPython 3.12.13, release 20260623, GNU Linux x86_64 baseline | Stdlib/extensions đúng nhu cầu profile, CPU/GLIBC baseline, môi trường sạch, chạy offline trong sandbox |
| Pascal | FPC 3.2.2 Linux x86_64 | Units/config/linker/CRT, không gọi công cụ host ngoài contract, relocation |
| Java | Temurin JDK 21; metadata 21.0.12+8 đã thu thập | Chọn patch bảo mật còn phù hợp tại lúc freeze; không dùng URL `latest` trong recipe |
| Scratch | Payload Linux đã dùng trong bản QA hiện tại | Giữ hash và bytecode nguyên vẹn; không `patchelf`/strip làm hỏng executable `pkg` |

Các số dung lượng archive upstream đã quan sát: GCC 160,079,152 bytes;
Python `install_only_stripped` 34,159,178 bytes; JDK 21.0.12+8 207,486,543 bytes.
Đây không phải tổng dung lượng Full: chưa gồm sysroot, Pascal, Scratch, dữ liệu sau
giải nén, cache và PCH. Chưa có cơ sở hứa kích thước bộ cài hoặc tỷ lệ nén cụ thể.

**C/C++:** chỉ lấy archive GCC rồi gọi là Full sẽ thiếu điều kiện quan trọng.
[Tài liệu xPack](https://xpack.github.io/docs/getting-started/prerequisites/)
vẫn yêu cầu headers/libraries của hệ thống cho native compilation. Full phải bổ sung
sysroot/CRT và kiểm soát tìm kiếm linker/helpers. Mục tiêu ứng viên là baseline Ubuntu
22.04/glibc 2.35 và dùng sysroot rõ ràng; chưa khẳng định archive xPack đáp ứng được
cho đến khi kiểm thử dependency closure. Nếu không đạt, đánh giá recipe build GCC
relocatable với sysroot thay vì yêu cầu người dùng cài `*-dev`.

Đã loại xPack 14.2.0-1: upstream xác nhận `libstdc++.so.6` phụ thuộc nhầm vào
`libiconv.so.2`; bản [14.2.0-2 sửa lỗi này](https://xpack-dev-tools.github.io/gcc-xpack/blog/2025/02/12/gcc-v14-2-0-2-released/).
Không dùng hardcoded `-static` hoặc đổi sang musl làm cách né sự khác biệt distro.
Các thư viện runtime được chọn phải đi vào sandbox theo package/role, không export
`LD_LIBRARY_PATH` chung cho desktop và các chương trình host.

**Python:** upstream cung cấp [distribution tự chứa](https://github.com/astral-sh/python-build-standalone/blob/main/docs/distributions.rst).
Không cần dựa vào `/usr/bin/python3`. Đóng interpreter, stdlib và native extensions
thuộc contract profile; không hứa kèm mọi package PyPI. Dùng artifact stripped do
upstream phát hành nếu được chứng nhận, không tự strip tùy ý sau khi pin hash.

**Pascal và Java:** không mặc định dễ hơn C/C++ đến mức có thể bỏ qua dependency audit.
FPC cần units và hỗ trợ link thích hợp; Java cần JDK đầy đủ, không chỉ JRE. Metadata
`latest` đã đổi trong lúc khảo sát nên phải freeze asset URL/hash/version cụ thể sau
kiểm tra cập nhật bảo mật và tính sẵn có, không pin theo tên tag động.

## 4. Hướng đóng gói ưu tiên

1. Xác minh nguồn và signed manifest tại build bằng các primitives đã có. Recipe
   pin URL, version, size, SHA-256, provenance và license/source information.
2. Giải nén có kiểm soát tại build vào resources, tạo file index chuẩn hóa bao gồm
   path, loại file, executable mode, size và digest. Nếu materialize symlink, index
   phải mô tả cây **sau** bước chuẩn hóa và giữ lại provenance của archive gốc.
3. Dùng compression của AppImage/DEB/RPM trước. Không thêm archive lồng nhau và
   runtime extractor chỉ để nén lần hai. Cách này tránh cần system Python để giải
   nén chính Python đi kèm. Đây là lựa chọn thiết kế ban đầu, cần đo size/startup.
4. Manifest và file index phải có điểm neo tin cậy. Hướng offline ưu tiên là pin
   digest của distribution lock/index trong application build, nối nó với manifest
   đã xác minh ở build. Chưa coi receipt tự khai hash là trust anchor. Xác minh
   runtime signed manifest cho tải/cập nhật riêng là phạm vi khác, không ngầm tuyên
   bố Rust hiện có Ed25519 verifier tương đương Node.
5. Import vào staging dưới thư mục ứng dụng có quyền ghi, xác minh nội dung rồi
   mới kích hoạt phiên bản. Thiết kế phải có khóa liên tiến trình, xử lý ENOSPC,
   interruption và rollback; không remove bản dùng được trước khi bản mới sẵn sàng.
   Package/cache identity phải phân biệt digest khi cùng package ID/version.
6. Chỉ báo ready sau compile/link/run probe thực trong đúng sandbox và với đúng
   package đã chọn. Thất bại phải giữ diagnostic, không tự chuyển compiler host.
7. Giữ lựa chọn toolchain hiện có khi nâng cấp. Full mới hoàn toàn có thể chọn
   managed packages mặc định, nhưng không tự ghi đè `local_path`/`none` đã lưu.

Không thêm dependency trong lượt nghiên cứu này. Nếu implementation cần một crypto
provider mới để xác minh streaming/signed manifest an toàn, phải nêu đề xuất cụ thể
trước khi thêm; không tự viết thuật toán mới. Helper hash hiện có đọc cả file vào
RAM cũng chưa phù hợp để áp thẳng cho archive hàng GB. Phải dùng primitive tin cậy
và giới hạn tài nguyên thích hợp, không chỉ tái sử dụng cho có.

Trust model này bảo vệ nguồn package/import và dữ liệu lỗi hoặc bị thay thế trong
phạm vi thiết kế; không hứa bảo vệ khỏi người đã kiểm soát executable hay cùng UID.
Submission không được quyền ghi toolchain. Không tận dụng hardlink vào cây writable
của submission làm tối ưu dung lượng.

## 5. Sandbox và PCH

**PCH vẫn dùng được.** Nó phải được tạo bằng compiler đi kèm, trong sandbox, sau
khi package được định vị ở cache cuối cùng. Identity cần bao gồm nội dung toolchain,
compiler, headers/sysroot, flags, target và cấu hình liên quan. Cơ chế hiện có trong
`crates/judgedesk-core/src/toolchains/pch.rs` là điểm mở rộng, không xây cache thứ hai.
Không phát một `.gch` duy nhất rồi giả định chạy mọi máy; xem các điều kiện của
[GCC về PCH](https://gcc.gnu.org/onlinedocs/gcc/Precompiled-Headers.html).
PCH miss không phải lý do chọn compiler khác.

Baseline Ubuntu 22.04 đã QA có bwrap được nâng cấp và CPU delegation hỗ trợ trước.
Do đó, nó chưa chứng minh Full hoạt động trên stock Ubuntu 22.04. Toolchain Full
không tự giải quyết những điều kiện này.

- bwrap stock 0.6.1 thiếu option đang cần. Nghiên cứu helper bwrap được pin đi kèm
  hoặc prerequisite phù hợp; không bỏ giới hạn mount/tmpfs để chạy được.
- Native executor hiện yêu cầu `cpu,memory,pids` và ghi `+cpu +memory +pids`.
  [Kernel documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html)
  phân biệt CPU accounting qua `cpu.stat` với bandwidth controller. Search hiện
  không thấy `cpu.max` trong executor. Đây là giả thuyết yêu cầu CPU delegation
  đang rộng hơn nhu cầu, **chưa phải kết luận được phép giảm kiểm tra**. Cần probe
  và hồi quy CPU accounting/TLE/interactive trên các kernel hỗ trợ trước mọi sửa đổi.
- AppArmor/SELinux/userns/cgroup capability vẫn phải được probe thực. Không tự
  sửa chính sách bảo mật toàn máy, chuyển submission ra ngoài sandbox hoặc dùng
  giao diện fallback để đánh đổi tương thích.

## 6. Trình tự implementation và tiêu chí nghiệm thu

1. **Contract và integrity trước:** test Linux package set đủ năm gói, missing
   package/empty set bị từ chối; file index/trust anchor; wrong hash, file mode,
   symlink escape, cache drift, same-version changed-digest, interruption và ENOSPC.
   Audit ảnh hưởng Windows/macOS trước thay đổi importer/cache chung.
2. **Một payload pilot nhỏ:** Python standalone, explicit managed runtime,
   diagnostics thật và bài AC/WA/RE/TLE; máy đích không có system Python và offline.
   Dùng pilot để đo import time và peak disk, chưa gọi nó là Full phát hành.
3. **C/C++ và Pascal:** sysroot/linker closure, helper path, dynamic runtime mounts,
   PCH cold/warm/invalidation và checker/interactive siblings. Test không có host
   `gcc`, `g++`, FPC hoặc headers dev; không cho host dependency che lỗi thiếu gói.
4. **Java/Scratch và installer:** JDK pin bảo mật phù hợp, payload Scratch không
   biến đổi; ba format dùng cùng distribution contract và file index. Core/Full
   có dependency list đúng edition; manifest/hash/license/source notices đi kèm.
5. **Full offline gate:** fresh user, stock prerequisite matrix, nguồn app chỉ đọc,
   path Unicode/khoảng trắng, noexec, thiếu dung lượng, restart, hai process, nhiều
   user, update Full→Full/Core và giữ preference. Chạy stress suite cùng các security
   probes hiện có, không giảm expected result hoặc giới hạn để đạt PASS.

Thực hiện test trước sửa behavior. Khi sửa runtime phải chạy các gate theo AGENTS.md,
native tests nếu chạm executor, và `release:check-version` khi chạm packaging.
Không cần tăng version chỉ để tạo biến thể Full.

Máy hiện hạn chế dung lượng. Không tải/build tất cả payload cùng lúc, tạo distro mới,
hoặc tạo thêm Cargo target trước khi đo. Resource payload + bản preserve + executor
cache + PCH có thể tạo nhiều bản sao; phải ghi số bytes thực và peak space. Tối ưu
bản sao chỉ được làm sau khi chứng minh không phá isolation, update và rollback.

## 7. Tự phản biện và kết luận

Các giả định bị bác bỏ: “Mac không bundle Python”; “AppImage chạy mọi distro”;
“archive GCC đủ để compile”; “receipt có hash là đã kiểm chứng file”; “thêm Linux
vào platform union là có Full”; “Full sẽ tự chữa mọi thiếu sót sandbox”; “PCH không
dùng được với managed compiler”; “nén thêm một lớp luôn tiết kiệm”.

Kết luận: Linux Full đủ sáu ngôn ngữ khả thi về hướng kỹ thuật. Python không phải
blocker bắt người dùng cài thêm. C/C++ cần nhiều công việc closure/sysroot hơn,
nhưng chưa có bằng chứng buộc phải bỏ mục tiêu bundle. Chỉ chốt release sau các
gate trên; nghiên cứu hiện tại chưa chứng nhận một payload Full hoàn chỉnh.

Nguồn giấy phép cần giữ trong recipe và kiểm tra lúc freeze: license/source tương
ứng GCC/binutils/glibc, Python và third-party components, [FPC FAQ](https://www.freepascal.org/faq.html),
[Temurin licensing FAQ](https://adoptium.net/docs/faq), cùng notices của Scratch.
Runtime exception không đồng nghĩa bỏ nghĩa vụ phân phối compiler và các nguồn
thành phần. Chưa coi bảng ứng viên ở đây là hoàn tất audit giấy phép.
