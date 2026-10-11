# Hướng dẫn Đóng góp vào JudgeDesk (Contributing Guidelines)

Cảm ơn bạn đã quan tâm đến việc đóng góp cho **JudgeDesk**! Dự án hoan nghênh mọi nỗ lực cải thiện, báo cáo lỗi, hoàn thiện tài liệu cũng như bổ sung tính năng mới từ cộng đồng lập trình viên và giáo viên.

---

## 1. Nguyên tắc Bất biến (Core Invariants & Quality Floor)

Mọi đóng góp mã nguồn (Pull Request) đều **phải tuân thủ nghiêm ngặt** các nguyên tắc kiến trúc sau (được quy định chi tiết tại [guidelines.md](guidelines.md) và [CONSTRAINTS.md](CONSTRAINTS.md)):

1. **Khóa phiên bản 8 tệp (8-File Version Lockstep):** Tuyệt đối không tự ý sửa đổi số phiên bản riêng lẻ. Mọi thay đổi phiên bản phải đồng bộ trên cả 8 tệp và vượt qua kiểm tra `npm run release:check-version`.
2. **Chấm điểm số hữu tỉ (Rational Scoring Invariant):** Không bao giờ sử dụng toán số thực (`float`/`double`) dấu phẩy động cho điểm số, xếp hạng hoặc bài nộp. Luôn dùng phân số tối giản qua `shared/rational.ts` và `server/judge/scoring.ts` để triệt tiêu sai số IEEE-754.
3. **Môi trường cách ly an toàn (Fail-Closed Sandbox):** Mã nguồn thí sinh phải luôn chạy trong sandbox cách ly (Windows AppContainer + Low Integrity / macOS Seatbelt). Không bao giờ hạ thấp rào chắn bảo mật.
4. **Không tự động chuyển đổi Compiler (No Compiler Fallback):** Nếu compiler được cấu hình gặp sự cố, hệ thống phải báo lỗi chẩn đoán rõ ràng, tuyệt đối không tự ý fallback sang một compiler khác trên máy host.
5. **Tiêu chuẩn mã nguồn (Code Standards):**
   - **TypeScript / Node.js:** Sử dụng Pure ES Modules (bắt buộc import kèm đuôi `.js`), strict typing (không dùng `any` bừa bãi, cấm hoàn toàn `@ts-ignore` và `@ts-nocheck`).
   - **Rust:** Không dùng `unwrap()` / `expect()` trên các nhánh runtime của server và executor; code phải sạch cảnh báo clippy (`cargo clippy -- -D warnings`).
   - **Giao diện (UI/UX):** Phong cách desktop tối giản, thực dụng, sắc nét (b borders 1px, `tabular-nums` cho số liệu). Không dùng hiệu ứng làm mờ nặng (`backdrop-blur`) hay đổ bóng khuếch tán sặc sỡ.
6. **Không tùy tiện thêm dependencies:** Ưu tiên sử dụng thư viện chuẩn của Node.js (`node:fs/promises`, `node:path`, `node:crypto`) và Rust `std`. Không cài đặt thêm package npm hoặc crate Cargo nếu không có sự thống nhất từ tác giả.

---

## 2. Thiết lập Môi trường Phát triển (Development Setup)

### Yêu cầu công cụ
- **Node.js:** `24.19.0` LTS với npm `11.17.0` (khuyên dùng Volta hoặc `.nvmrc`).
- **Rust:** `1.97.1` (được định nghĩa trong `rust-toolchain.toml`).
- **Windows:** Visual Studio C++ Build Tools (gói *Desktop development with C++*) và Microsoft Edge WebView2 Runtime.
- **macOS:** Xcode Command Line Tools (`xcode-select --install`).

### Khởi động dự án cục bộ

```powershell
# 1. Cài đặt dependencies
npm ci

# 2. Chạy kiểm tra nhanh chất lượng code
npm run check:fast

# 3. Khởi động môi trường dev (Frontend Vite + Backend Express)
npm run dev

# 4. Chạy ứng dụng desktop đầy đủ với Tauri
npm run test:desktop
```

---

## 3. Quy trình Kiểm thử (Verification Pipeline)

Trước khi gửi Pull Request, bạn **bắt buộc** phải chạy và đảm bảo các bài kiểm tra sau vượt qua thành công:

```powershell
# Kiểm tra TypeScript và Quality Gate (< 5s)
npm run check:fast

# Kiểm tra bộ test backend & judge logic (> 520 tests)
npm run test:server

# Kiểm tra toàn diện Rust executor và parity gates
npm run check:full
```

---

## 4. Quy trình Gửi Pull Request (PR Workflow)

1. **Fork** repository `ducminh25/judgedesk-source` về tài khoản GitHub của bạn.
2. Tạo một nhánh mới từ `main` với tên mô tả ngắn gọn:
   ```bash
   git checkout -b fix/scoring-edge-case
   # hoặc
   git checkout -b feat/custom-checker-preview
   ```
3. Áp dụng quy trình TDD (Test-Driven Development): Viết bài test tái hiện lỗi / mô tả tính năng mới trước khi viết code triển khai.
4. Chạy `npm run check:fast` và `npm run test:server` để xác nhận toàn bộ test đều xanh (PASS).
5. Commit thay đổi theo chuẩn [Conventional Commits](https://www.conventionalcommits.org/):
   - `fix(judge): handle edge case in rational division`
   - `feat(ui): add keyboard shortcut for scoreboard export`
6. Đẩy nhánh lên fork của bạn và mở **Pull Request** nhắm vào nhánh `main` của repository gốc kèm theo mô tả rõ ràng về:
   - Vấn đề mà PR giải quyết.
   - Cách bạn kiểm thử và kết quả test.
   - Bất kỳ ảnh hưởng nào (nếu có) đến các tầng kiến trúc khác.

---

## 5. Giấy phép Đóng góp (Licensing of Contributions)

Khi bạn gửi đóng góp mã nguồn vào repository này, bạn đồng ý rằng mã nguồn đóng góp của bạn sẽ được cấp phép theo các điều khoản của [JUDGEDESK SOURCE CODE LICENSE](LICENSE).
