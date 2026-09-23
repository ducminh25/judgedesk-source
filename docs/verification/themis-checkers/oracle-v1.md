# Báo cáo Themis Oracle Baseline v1

- **Ngày thực hiện:** 2026-09-22
- **Môi trường:** Windows x64
- **Themis Version:** 1.9.8.2806 (Themis.exe SHA-256: `9BCEE23CA00D60977BC6EFBE16752C872E778E2548231E999FD4FD98DA184920`)
- **Vị trí DLL:** `C:\Themis\~judgers`
- **Harness thực thi:** `d:\Minh\Code\judgedesk\tmp-oracle-runner\runner.exe` (gọi trực tiếp hàm exported `Judge` theo chuẩn 32-bit `__stdcall` của Themis DLLs).

---

## 1. Bảng mã băm SHA-256 của các Themis DLLs

| DLL | Dung lượng (bytes) | SHA-256 |
|---|---|---|
| `C1LinesWordsIgnoreCase.dll` | 2,312,192 | `96145B8E1E74B32D8ED995439871FB771FA0FEFBAF502AF6217E53918F3FCB12` |
| `C2LinesWordsCase.dll` | 2,312,192 | `94AAFCDABC491ED85FDF0485D74B7F44609317B158BCEC813A65337C7DC0AA7F` |
| `C3WordsIgnoreCase.dll` | 2,312,192 | `4E2EA751CB78BE300FF00CDEA329C2F2A36D064C7E56AA55B6B4D0D7EB598F94` |
| `C4WordsCase.dll` | 2,311,680 | `1A5545B42C01C894F60F8C6517986580368A92B6868A1CE2D76FDDDFC9F95BE8` |
| `C5Binary.dll` | 2,310,144 | `DC463A5786B379450D2E68BF9C4F758C44E94FBCAEC4CD27595C8E76AA26689A` |

---

## 2. Kết quả kiểm thử Oracle trực tiếp

### 2.1 Bộ test gốc BAI5 (C1LinesWordsIgnoreCase.dll)

| Test | Expected Raw Bytes (Hex) | Actual Output | Score | Comment Themis | Oracle Status |
|---|---|---|---|---|---|
| test00 | `34 0D 0D 0A` (`4\r\r\n`) | `4` | 1.0000 | Kết quả khớp đáp án! | **CONFIRMED AC** |
| test01 | `36 0D 0D 0A` (`6\r\r\n`) | `6` | 1.0000 | Kết quả khớp đáp án! | **CONFIRMED AC** |
| test02 | `37 0D 0D 0A` (`7\r\r\n`) | `7` | 1.0000 | Kết quả khớp đáp án! | **CONFIRMED AC** |
| test03 | `31 31 0D 0D 0A` (`11\r\r\n`) | `11` | 1.0000 | Kết quả khớp đáp án! | **CONFIRMED AC** |
| test04 | `31 38 0D 0D 0A` (`18\r\r\n`) | `18` | 1.0000 | Kết quả khớp đáp án! | **CONFIRMED AC** |
| test05 | `35 33 0D 0D 0A` (`53\r\r\n`) | `53` | 1.0000 | Kết quả khớp đáp án! | **CONFIRMED AC** |
| test06 | `31 34 34 0D 0D 0A` (`144\r\r\n`) | `144` | 1.0000 | Kết quả khớp đáp án! | **CONFIRMED AC** |
| test07 | `32 33 32 0D 0D 0A` (`232\r\r\n`) | `232` | 1.0000 | Kết quả khớp đáp án! | **CONFIRMED AC** |
| test08 | `32 35 38 0D 0D 0A` (`258\r\r\n`) | `258` | 1.0000 | Kết quả khớp đáp án! | **CONFIRMED AC** |
| test09 | `32 37 30` (`270`) | `270` | 1.0000 | Kết quả khớp đáp án! | **CONFIRMED AC** |

### 2.2 Các biến thể EOL ở cuối tệp (EOF)
- `144\r\n` vs `144`: Score 1.0000 (AC) cho cả C1 và C2
- `144\n` vs `144`: Score 1.0000 (AC) cho cả C1 và C2
- `144\r` vs `144`: Score 1.0000 (AC) cho cả C1 và C2
- `144\r\r\n` vs `144`: Score 1.0000 (AC) cho cả C1 và C2
- `144` vs `144\r\n`: Score 1.0000 (AC) cho cả C1 và C2
- `144` vs `144\r\r\n`: Score 1.0000 (AC) cho cả C1 và C2

### 2.3 `\r\r\n` ở giữa tệp
- `a\r\r\nb` so với `a\r\nb`: Score 0.0000 (WA).
- `a\r\r\nb` so với `a\r\n\r\nb`: Score 1.0000 (AC).
$\rightarrow$ **Kết luận:** Trong Themis, `\r\r\n` ở giữa tệp gồm 2 EOL liên tiếp: 1 EOL kết thúc dòng trước và 1 EOL tạo ra dòng trống ở giữa! Khi ở cuối tệp, dòng trống này bị drop vì là trailing blank line.

### 2.4 Dòng trống: Đầu, Giữa, Cuối
- Dòng trống cuối file (ở cả Expected và Actual): Đều được bỏ qua (Score 1.0000 AC).
- Dòng trống đầu file (ở Expected hoặc Actual): Không được bỏ qua, dẫn đến lệch dòng (Score 0.0000 WA).
- Khoảng trắng/tab ở đầu dòng, giữa dòng: Bị bỏ qua, chỉ tính từ (Score 1.0000 AC).

### 2.5 C3 / C4: Tokenize theo từ
- Từ phân cách bằng `\n` vs `\r\n`: C3 Score 1.0000 AC.
- Phân biệt chữ hoa/thường: C3 Score 1.0000 AC, C4 Score 0.0000 WA.
- Sai khác từ trước khi sai khác số lượng từ: Báo sai khác từ.

### 2.6 Byte đặc biệt (VT, FF, BOM, Non-ASCII)
- VT (`0x0B`) và FF (`0x0C`): **Không** được coi là khoảng trắng. Được coi là opaque byte.
- UTF-8 BOM (`EF BB BF`): **Không** bị tự động strip. Phải khớp nguyên trạng byte.
- Non-ASCII: Giữ nguyên dạng byte, không tự ý case-fold ngoài miền ASCII `A-Z`.
