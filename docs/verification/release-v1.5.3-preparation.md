# Chuẩn bị nguồn v1.5.3

Ngày: 2026-10-06 (Asia/Bangkok). Phạm vi: review, verification, commit và merge nguồn; không tạo bộ cài, tag, release, đổi visibility repository hoặc gọi workflow release.

## Phạm vi merge

- Đồng bộ tám file version app/executor ở 1.5.3. Crate judgedesk-core độc lập vẫn ở 1.5.1; lockfile chỉ cập nhật identity của dependency executor.
- Changelog Markdown và hai ngôn ngữ trong app sao chép mục nhận test của v1.5.2, thêm đúng `Bug fixes.`.
- Giữ các bản vá đã triển khai: PCH theo compiler/flags/identity thực thi đã xác minh, staging header và PCH vào compiler workspace, bỏ lượt compile/link no-op dư thừa, giữ preparation và kiểm tra compiler bắt buộc. Diagnostic timing chỉ bật khi `JUDGEDESK_JUDGE_TRACE=1`.
- Không triển khai phương án PCH idle/cancellation hoặc thay đổi console launch/watchdog/time limit. Không thay đổi sandbox native trong đợt chuẩn bị này.

## Đề xuất warm-up đã dừng

File [prewarm-pch-deferral.test.ts.txt](proposals/prewarm-pch-deferral.test.ts.txt) giữ nguyên toàn bộ nội dung test RED chưa được commit trước đó. Đây là test của **hành vi đề xuất chưa triển khai**, được viết ngay trước khi người dùng yêu cầu dừng mọi chỉnh sửa; nó đòi readiness không chờ cold PCH trong khi code hiện tại vẫn chờ. Vì người dùng chỉ yêu cầu merge các thay đổi đã có và chuẩn bị release, test được chuyển sang tài liệu đề xuất, không đưa hành vi mới vào release. Không xóa, skip hoặc giảm assertion của bất kỳ regression test đã triển khai nào. Đây là lý do bằng văn bản cho việc rút test đề xuất khỏi test discovery, không phải bằng chứng đã sửa cold warm-up.

## Verification trong lượt chuẩn bị

Đã chạy `npm run check:full` với kết quả **PASS** toàn diện:
- `check:fast`: PASS, Node 24.19.0 / npm 11.17.0, typecheck và quality-gate sạch.
- `test:rust`: PASS, 9/9 bước qua cả 3 thành phần (`native-executor`, `crates/judgedesk-core`, `src-tauri`).
- `test:server`: PASS, 775 tests (765 pass, 0 fail, 10 skip có sẵn).
- `test:themis-parity`: PASS, 67/67 fixtures trên cả 4 tiers (Node, Rust core, C++, Windows packaged C1-C5).
- `release:check-version`: PASS, đồng bộ đúng version 1.5.3.
- `changelog`: cập nhật test và modal đồng bộ hiển thị 1.5.3.
Gate này biên dịch mã để chạy test và chuẩn bị executor cho test; không phải build bộ cài/release.

## Giới hạn đã biết

- Cold PCH vẫn có thể giữ trạng thái Verifying khoảng 10 giây; cache nóng có thể tái sử dụng. Không tuyên bố đã loại bỏ hoàn toàn warm-up hoặc đã chứng minh/sửa nguyên nhân TLE ngẫu nhiên trước reboot.
- Book1 Windows đã đối soát khớp expected hiện có; chưa thay thế acceptance trên bộ cài từ commit sạch hoặc kiểm tra macOS.
- Các đường sandbox ResourceOnly/Pascal/Scratch và fallback lỗi 623 đã tồn tại ở v1.5.1/v1.5.2, được ghi trong [audit Windows](v1.5.3-book1-stress-audit.md). Merge bản vá này không khắc phục các đường đó; test expected AC không chứng minh mọi bài nộp đã được cô lập zero-network. Các phát hiện này cần quyết định trước phát hành chính thức.

## Hướng dẫn release sau khi bạn quyết định thực hiện

Các lệnh dưới đây là hướng dẫn, **không được thực hiện trong lượt chuẩn bị**.

1. Dùng đúng commit `main` đã chuẩn bị, checkout sạch (`git status --short` trống), Node 24.19.0/npm 11.17.0/Rust 1.97.1. Hoàn tất quyết định về các giới hạn trên. GitHub workflow `Verify Release Source` chỉ kiểm tra nguồn, không tạo bộ cài; nó chạy khi push tag `v*` hoặc khi dispatch thủ công. Nếu muốn chạy gate CI trước build, chọn workflow này trên `main` và xác nhận SHA đúng commit đã chuẩn bị.
2. Trên Windows, chạy:

   ```powershell
   Set-Location D:\Minh\Code\judgedesk
   npm run release:check-version
   npm run build:windows:release:local
   ```
   Thu Core/Full MSI và metadata trong `release-assets-windows`.
3. Khi sẵn sàng ký updater Windows, upload hai MSI **và metadata tương ứng** vào prerelease `v1.5.3-staging` của repository phân phối `ducminh25/judgedesk`. Chạy CodeMagic `windows-updater-signing` tại cùng commit nguồn, truyền `WINDOWS_CORE_MSI_SHA256` và `WINDOWS_FULL_MSI_SHA256` là hash của đúng MSI vừa kiểm. Nhóm `themis_signing` phải có `TAURI_SIGNING_PRIVATE_KEY` (và password nếu key có password). Tải lại MSI, `.sig`, metadata và checksum; hash phải khớp bản đã kiểm. Chữ ký updater không thay thế Authenticode.
4. Chạy CodeMagic `macos-arm64-release` tại cùng commit nguồn để tạo Core/Full Apple Silicon DMG và updater bundle, chữ ký, metadata. Kiểm trên Mac trước phát hành; chưa có acceptance Mac trong lượt này.
5. Chỉ khi tất cả các build ở CodeMagic hoàn thành GREEN, gom sáu bundle công khai (hai MSI, hai DMG, hai `.app.tar.gz`) cùng bốn chữ ký updater và bốn metadata vào `release-staging`. Sinh manifest, assemble và verify:

   ```powershell
   $env:PUBLIC_RELEASE_REPOSITORY = 'ducminh25/judgedesk'
   $env:GITHUB_REF_NAME = 'v1.5.3'
   node scripts/generate-updater-manifest.js release-staging
   node scripts/assemble-public-release.mjs
   npm run release:verify-public-assets -- public-release-assets v1.5.3
   ```
   `public-release-assets` phải có đúng tám asset: sáu bundle, `latest.json`, `SHA256SUMS`. Các chữ ký updater nằm trong manifest; giữ file `.sig`/metadata gốc trong bằng chứng build.
6. Chỉ sau acceptance, tạo/push tag nguồn `v1.5.3` trỏ đúng commit đã build (push tag sẽ kích hoạt GitHub source verification). Tạo draft release `v1.5.3` ở `ducminh25/judgedesk`, upload tám asset đã verify, ghi changelog hai dòng như trên. Publish và kiểm updater/download, rồi dọn staging khi đã xác nhận. Repository source `ducminh25/judgedesk-source` giữ nguyên visibility, không cần public source để release app.
