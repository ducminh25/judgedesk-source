# Đăng thông báo Admin cho JudgeDesk

Hướng dẫn soạn, kiểm tra và xuất bản feed có chữ ký qua GitHub Pages. Chỉ kích hoạt publisher sau khi cấu hình trust, source pin, quyền xuất bản và key riêng. Không dùng key/UID trong test fixtures để phát hành tin.

## 1. Hai repository

- `ducminh25/judgedesk-source`: code app, publisher, policy HTML, trust store công khai và các test.
- `ducminh25/judgedesk`: catalog, bài viết, ảnh và workflow Pages. Các release/updater hiện có không tham gia tính năng này.
- URL thiết kế: `https://ducminh25.github.io/judgedesk/announcements/v1/feed.json`. Chỉ coi là hoạt động sau khi deploy và smoke xác minh thành công.

Tree để review/copy có tại `scripts/announcements/distribution/`. Đây không phải workflow đang hoạt động trong source repo. Giữ nguyên tài liệu, issue templates và releases hiện có khi đưa các file mới sang repo phân phối.

## 2. Tạo bài nháp

Chạy từ checkout source có các dependency đã duyệt:

```powershell
node --import tsx scripts/announcements/publisher-cli.ts new-post "<distribution-checkout>" "Tiêu đề" "Tóm tắt ngắn"
```

Lệnh tạo UUID v4 mới, thư mục `announcements/posts/<uid>/`, metadata, `vi.html` và thêm một dòng `draft` vào catalog. Tạo thư mục `announcements/posts/` trước nếu checkout ban đầu còn rỗng. CLI dùng lock độc quyền; nếu process chết để lại `.new-post.lock`, kiểm tra process và thay đổi dở trước khi xử lý lock thủ công. Không tự phá lock theo PID hoặc đoán rằng một process đã chết.

Sửa các file sau:

```text
announcements/publication.json
announcements/catalog.json
announcements/posts/<uid>/metadata.json
announcements/posts/<uid>/vi.html
announcements/posts/<uid>/en.html             # tuỳ chọn
announcements/posts/<uid>/images/guide.jpg
announcements/posts/<uid>/images/preview.png  # thumbnail riêng, tuỳ chọn
```

Giữ UID do lệnh trả về; không copy UID của bài khác. Metadata có `uid`, `revision`, `publishedAt`, `updatedAt`, `content.vi` với `title`/`summary`, và `images`. Muốn có EN thì thêm cả `content.en` và `en.html`; thiếu EN thì app dùng nội dung VI và giữ nguyên trạng thái đọc/xoá.

Ví dụ phần khai báo ảnh trong metadata:

```json
{
  "images": [
    { "id": "guide", "file": "images/guide.jpg", "role": "article" },
    { "id": "preview", "file": "images/preview.png", "role": "thumbnail" }
  ],
  "thumbnailId": "preview"
}
```

Ví dụ nội dung `vi.html`:

```html
<h2>Hướng dẫn mới</h2>
<p>Đoạn văn đầu tiên có thể có <strong>chữ đậm</strong>.</p>
<figure class="wide">
  <img data-announcement-image="guide" alt="Minh hoạ các bước chuẩn bị">
  <figcaption>Chú thích cho ảnh.</figcaption>
</figure>
<p>Đoạn văn tiếp theo có
  <a href="https://github.com/ducminh25/judgedesk/issues">liên kết hỗ trợ</a>.
</p>
```

Ảnh dùng `data-announcement-image` khớp ID trong metadata. Không đưa URL ảnh Internet hoặc đường dẫn máy cá nhân vào HTML. Link nguồn dùng `href`; publisher chuyển link hợp lệ thành ID trong manifest có chữ ký. App mở link bằng command native riêng. Chỉ chấp nhận HTTPS trong repo `ducminh25/judgedesk` và Pages project tương ứng; thêm domain là thay policy được review.

## 3. Giới hạn nội dung

| Dữ liệu | Giới hạn v1 |
| --- | --- |
| Tiêu đề / tóm tắt | 200 / 500 ký tự, plain text, không rỗng |
| HTML mỗi ngôn ngữ | 64 KiB UTF-8, 5.000 node, sâu tối đa 32 |
| Ảnh trong bài | Tối đa tám ảnh khai báo và tám thẻ ảnh trong mỗi bản HTML, kể cả lặp cùng ID |
| JPG/JPEG/PNG | 4 MiB/ảnh, 12 MP, mỗi cạnh tối đa 8192 px |
| Thumbnail riêng | 128 KiB, tối đa 320×320; có thể bỏ để dùng biểu tượng chuông |
| Feed | Tối đa 100 bài, payload 1 MiB, envelope 1,5 MiB |
| Media của site | Budget 512 MiB; vượt thì dừng, không tự xoá ảnh cũ |

JPG/JPEG được xuất bản thành extension `jpg`; PNG phải tĩnh. APNG, SVG, GIF, WebP không được hỗ trợ. Node kiểm tra header/bytes/hash; native app kiểm tra hash, MIME, kích thước và decode ảnh thật. Một ảnh mới hỏng có thể bị app chặn dù vượt qua kiểm tra header ở publisher; phần chữ vẫn đọc được. Không coi build Node là bằng chứng đã decode mọi ảnh tác giả mới đưa vào.

HTML hỗ trợ đoạn văn, h2–h4, strong/em, danh sách, quote, pre/code, figure/caption, img, a, br/hr, div/span. Không hỗ trợ script, style, iframe, SVG/MathML, form, thuộc tính sự kiện, CSS tuỳ ý hay điều khiển focus. Class bố cục cho phép: `wide`, `align-left`, `align-center`, `align-right`. Bài cần có văn bản đọc được sau khi lọc.

## 4. Sửa, đăng và thu hồi

1. Kiểm tra nội dung nháp, đường dẫn ảnh và bản EN nếu có.
2. Đổi catalog entry sang `published`. UID, revision và publishedAt trong catalog phải khớp metadata.
3. Khi sửa bài đã từng đăng, tăng `revision` trong cả metadata và catalog, cập nhật `updatedAt`; không thay `publishedAt`.
4. Mỗi lần thay artifact xuất bản phải tăng `publication.sequence` và đặt `generatedAt` UTC canonical, ví dụ `2026-10-24T07:00:00.000Z`. Không giảm sequence. Rerun cùng sequence chỉ hợp lệ nếu payload/media không đổi.
5. Muốn thu hồi: đổi status sang `archived`, giữ entry và các file. `expiresAt` tuỳ chọn sẽ ẩn bài khỏi danh sách/badge theo clock máy người dùng; không xoá lịch sử UID.

Sửa cùng UID giữ trạng thái đã đọc/xoá trên từng máy. Muốn nhắc lại, tạo bài với UID mới. Trạng thái không đồng bộ giữa các máy; không có tài khoản hay analytics đọc tin.

**Giữ ảnh lịch sử:** không xoá hoặc ghi đè file ảnh cũ khi đổi ảnh. Thêm tên mới, ví dụ `guide-v2.jpg`, rồi sửa metadata/HTML. Publisher xuất toàn bộ ảnh giữ trong source, kể cả ảnh của bài archived và ảnh không còn tham chiếu; so với source trước đó, thiếu một blob lịch sử sẽ làm build thất bại. V1 không GC media trên Pages.

Preview/build cục bộ với checkout trước đó:

```powershell
node --import tsx scripts/announcements/publisher-cli.ts build "<distribution-checkout>" "<new-output-directory>" "<previous-distribution-checkout>"
```

Output directory phải mới và nằm ngoài source `announcements/`. Output gồm payload chưa ký và media theo hash. Bỏ đối số previous chỉ dùng để preview/khởi tạo chưa có lịch sử; không thay thế guard xuất bản. Workflow PR so với base, push so với commit trước, và signer luôn kiểm tra baseline production.

## 5. Kích hoạt production — các quyết định còn cần chốt

Public key nằm trong `shared/announcements-trust.json`; private key do chủ dự án giữ và chỉ cung cấp cho signing environment. Với chế độ duyệt thủ công, cấu hình required reviewer của environment là người sở hữu quyền xuất bản; chỉ cho phép branch `main`, không cho tag. Chủ repo duy nhất cần có thể duyệt run do chính mình khởi tạo; điều này vẫn yêu cầu thao tác duyệt thủ công.

### Tự tạo key trên Windows

Mở PowerShell thường, không cần Administrator. Kiểm tra `node --version`; Node của dự án đã có sẵn, không cần cài OpenSSL hoặc npm package mới. Chạy khối dưới đây **một lần**. Thư mục mặc định ở ngoài repo; có thể đổi `$announcementKeyDir` trước khi chạy. Nếu thư mục đã tồn tại, lệnh dừng để tránh tạo nhầm key thay thế.

```powershell
$ErrorActionPreference = 'Stop'
$announcementKeyDir = 'D:\JudgeDesk-Private\announcements-v1'

if (Test-Path -LiteralPath $announcementKeyDir) {
    throw 'Thu muc key da ton tai. Dung lai, khong tao de key moi.'
}
New-Item -ItemType Directory -Path $announcementKeyDir | Out-Null
$announcementOwnerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls.exe $announcementKeyDir /inheritance:r /grant:r "*${announcementOwnerSid}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Khong thiet lap duoc quyen thu muc. Chua tao key.' }

@'
const { generateKeyPairSync } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const directory = process.argv[2];
if (!directory) throw new Error('Missing private directory');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicBytes = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
if (publicBytes.length !== 32) throw new Error('Invalid public key length');
const publicConfig = JSON.stringify({
  keyId: 'announcements-v1',
  publicKeyBase64: publicBytes.toString('base64')
}, null, 2);
const options = { flag: 'wx', mode: 0o600, flush: true };
writeFileSync(join(directory, 'private-key.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }), options);
writeFileSync(join(directory, 'public-key.pem'), publicKey.export({ format: 'pem', type: 'spki' }), options);
writeFileSync(join(directory, 'public-key.json'), publicConfig + '\n', options);
console.log(publicConfig);
'@ | node - $announcementKeyDir

if ($LASTEXITCODE -ne 0) { throw 'Tao key chua hoan tat. Giu nguyen thu muc va kiem tra loi.' }
```

`icacls` đặt quyền cho tài khoản Windows hiện tại và loại quyền kế thừa trên thư mục mới; không thay quyền của repo/ổ đĩa. Private PEM không có mật khẩu riêng, phù hợp signer hiện tại; hạn quyền không thay thế mã hoá bản backup. Chỉ output public JSON được in ra terminal.

- Giữ riêng `private-key.pem`, không gửi vào chat, commit hoặc đưa vào artifact. Sao lưu vào kho mật khẩu hỗ trợ file hoặc thiết bị lưu trữ được mã hoá. Không tạo lại key mỗi lần đăng tin.
- `public-key.pem` và `public-key.json` là dữ liệu công khai. Gửi nội dung **public-key.json** để cấu hình app. Có thể mở lại bằng `Get-Content -LiteralPath 'D:\JudgeDesk-Private\announcements-v1\public-key.json'`.
- Chưa đưa private key lên GitHub ở bước này; chỉ cấp secret cho đúng signing environment sau khi hoàn tất policy/pin bên dưới.

Lệnh dựa trên [Node crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptogeneratekeypairsynctype-options) và [Windows icacls](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls). Đây là hướng dẫn để chủ dự án tự chạy; agent không thực thi bước tạo key production.

### Các điều kiện trước khi bật publisher

Trước khi bật, cần chủ sở hữu khoá ký, nơi giữ bản khôi phục riêng, source commit thật và kết quả QA phát hành. Không tạo key production rồi lưu vào repo/test fixture để tiện thử.

- Dùng một key Ed25519 riêng cho thông báo, private key PKCS#8 PEM. Không dùng lại key updater/toolchain.
- Chủ sở hữu tạo/giữ private key ngoài source/artifact/log; quyết định nơi backup và quyền truy cập trước khi cấp cho CI.
- Đưa **chỉ public key 32 byte base64** và keyId vào `shared/announcements-trust.json`. Signer kiểm tra public key dẫn xuất từ private key khớp cấu hình này.
- App và publisher dùng cùng trust file/endpoint. Key rotation/revocation cần thiết kế migration/bản app mới; feed không có quyền tự cấp key.
- Review và push source chứa tool, policy, public trust và lockfile. Ghi full 40-hex commit thật vào `announcements/publisher.lock.json`:

```json
{
  "sourceRepo": "ducminh25/judgedesk-source",
  "sourceCommit": "<full-reviewed-40-hex-commit>"
}
```

Placeholder trên không phải pin hợp lệ. Không dùng HEAD cũ chưa có tool, branch/tag trôi nổi hoặc SHA tự đặt. Staging tree cố ý chưa có lock này.

Commit được chọn cần chứa publisher, shared policy/schema/public trust, các fixture cần thiết và package/lockfile tương ứng. Review, commit và push lên `ducminh25/judgedesk-source` trước khi điền pin/variables. Nếu commit được chọn là HEAD, lấy SHA bằng `git rev-parse HEAD`; lệnh này tự nó không chứng minh commit đã được push.

Thiết lập chính sách trên distribution repo trước khi cấp secret:

- Bảo vệ `main` và review workflow/publisher pin; guard từ chối main không được bảo vệ.
- Environment `announcements-signing`: chỉ `main`, policy reviewer do chủ repo chốt, secret `ANNOUNCEMENTS_SIGNING_PRIVATE_KEY` và variable `ANNOUNCEMENTS_KEY_ID`.
- Repository variable và variable của signing environment `ANNOUNCEMENTS_PUBLISHER_SOURCE_COMMIT`: cùng full source commit đã duyệt. Checkout resolver từ variable này phải qua kiểm tra full SHA trước; không nhận giá trị rỗng rồi checkout default branch.
- Environment `github-pages`: chọn riêng nhánh `main` và policy deployment đã duyệt. Không chỉ dựa vào lựa chọn “protected branches only” khi repo chưa có rule.
- Bật Pages source **GitHub Actions**. Không thay updater endpoint, latest.json hay release assets.

Workflow gồm build không có secret; sign dùng Node built-ins, không npm install; deploy chỉ nhận artifact đã ký và có Pages/OIDC permissions. Signing job có quyền đọc deployment để kiểm tra lần đầu. Các action được pin SHA; workflow chỉ được kích hoạt sau review này.

## 6. Bootstrap, rerun và propagation

Lần đầu cần xác nhận repo chưa từng deploy Pages và chọn **đúng commit main đầu tiên**. Đặt `ANNOUNCEMENTS_BOOTSTRAP_COMMIT` theo SHA đó ở repo/signing environment sau khi review. Có thể dùng feed rỗng có chữ ký làm lần đầu; cần duyệt riêng nếu muốn đăng bài đầu tiên ngay.

Signer kiểm tra current protected main, live signed baseline và lịch sử deployment. HTTP 404 không được hiểu là sequence 0. Chỉ khi baseline chưa tồn tại, commit được duyệt và chưa có deployment Pages nào thì signer mới cấp authorization qua output của chính signing job.

Job `github-pages` tạo deployment record của nó trước khi các step chạy. Vì vậy predeploy dùng authorization từ signing job, ràng buộc **run ID + run attempt + commit + payload hash**, đồng thời đọc lại live baseline và main HEAD; không tự bootstrap lại dựa vào 404. Authorization không lấy từ author content hay unsigned artifact. Rerun attempt khác không được dùng lại quyền bootstrap cũ. Sau lần đầu, gỡ variable bootstrap; feed mất hoặc không xác minh được thì dừng và điều tra.

Khi nâng publisher pin: PR vẫn được kiểm tra bằng tool của base main. Sau khi merge pin mới, owner cập nhật variable source commit đã duyệt rồi rerun main; workflow dừng rõ nếu pin và variable chưa khớp. Không tự chuyển sang source ref khác.

Sau deploy, smoke GET bounded retry kiểm tra chữ ký, sequence/hash và tối đa ba ảnh mẫu. Pending propagation là trạng thái lỗi/chưa xác nhận, không phải mọi máy đã nhận tin. Không rollback sequence để sửa propagation; sửa source và xuất bản sequence mới. Rerun cũ phải còn là main HEAD và không được hạ baseline.

## 7. Dữ liệu trên máy người dùng và khôi phục

App fetch một lần mỗi phiên, tải lại ở nền khi mở panel nếu đã stale hơn 30 phút, và có nút Tải lại. Mất mạng giữ danh sách/cache hợp lệ; không có popup tự động. Mở panel không đánh dấu đọc; mở bài chỉ đánh dấu sau khi phần chữ render thành công. Ảnh lỗi không chặn đọc chữ.

Kho dữ liệu nằm dưới root app hiện có qua `get_app_data_dir()`, dùng chung Core/Full và Linux deb/rpm/AppImage. `state.json` giữ pointer/high-water/read/delete; feed và media nằm trong thư mục con cố định. State/tombstone không bị xoá khi bài vắng mặt. State cap 16 MiB: vượt thì từ chối ghi, không prune lịch sử.

Nếu dữ liệu hỏng, giữ bản gốc để điều tra. Không xoá cả `announcements/` hoặc reset `state.json` để “sửa cache”, vì sẽ mất mốc chống rollback và lịch sử xoá. Với lỗi chỉ ở media/feed blob, xác định đúng leaf theo hash, backup và xử lý riêng khi app đã đóng; tải lại vẫn phải qua chữ ký/hash/decoder. Không đổi quyền thư mục toàn bộ app hoặc trỏ root sang package directory để né lỗi.

## 8. Kiểm tra trước khi phát hành

Chạy các gate của dự án, xác minh live signed Pages và kiểm tra các package Windows/macOS Core/Full, Linux Core/Full deb/rpm/AppImage trước khi công bố hỗ trợ bản mới. Native WebView với fixture client không thay thế end-to-end production Pages hoặc cài/upgrade package. Giữ version lockstep giữa tám file khi phát hành.

Giới hạn decoder `max_alloc=64 MiB` là best effort, không phải quota RAM OS. Corpus 12 MP baseline/progressive/CMYK/PNG chỉ là mẫu tham chiếu, không chứng minh mọi JPEG độc hại. Đo working set/latency và ảnh hưởng khi chấm trên candidate thực tế; không hứa toàn bộ pipeline ảnh chỉ dùng 64 MiB. Các giới hạn input/dimension/output, semaphore một decoder và huỷ network theo view vẫn bắt buộc.

Nguồn nền tảng: [GitHub Pages workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [environment và protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), [API deployment](https://docs.github.com/en/rest/deployments/deployments#list-deployments), [image decoder limits](https://docs.rs/image/0.25.10/image/struct.Limits.html). Đối chiếu các yêu cầu nền tảng với cấu hình và candidate thực tế trước khi phát hành.
