# Review Problem Config Modal Plan

Ngày 2026-10-07. Đọc toàn bộ 377 dòng `docs/problem-config-modal-plan.md`, đối
chiếu ProblemConfigModal, CompileProblemSettings và tests, useProblemConfigEditor,
BasicProblemSettings, GroupPolicyTable, TestEditPopover, shared/contracts,
translations, index.css và scripts hiện tại. Không triển khai runtime.

Verdict: hướng A phù hợp; cần chỉnh acceptance và các ví dụ trước implementation.
Giữ mounted bằng display:none là quyết định đúng để bảo vệ local draft/validation.
Giữ hook/API/rational và đóng popover khi chuyển tab cũng phù hợp.

## Required findings

1. **P1 — Contrast trái contract (plan 35, 322–328).** White trên #059669 =
   3.77:1; white trên hover #10b981 = 2.54:1, dưới 4.5 cho text-xs. Footer dùng
   rose-500 #f43f5e trên #f8fafc = 3.51:1. Ngay rose-600 #e11d48 trên #f8fafc
   chỉ 4.49:1. Chọn palette đạt chuẩn cho normal/hover/error; light primary
   #285f54 + white đạt 7.36:1. Các số được tính từ sRGB tương đối, chưa là đo
   screenshot thực tế. Disabled opacity xét riêng; không dùng để chữa active.

2. **P1 — Tab roles thiếu hành vi keyboard (168–195).** Bổ sung roving tabIndex
   (active 0, còn lại -1), Left/Right wrap, quyết định automatic/manual activation,
   Home/End nếu hỗ trợ, type=button và focus-visible trên tab/close/footer. ARIA
   roles không tự cung cấp keyboard behavior. Dùng IDs ổn định/unique và liên kết
   dialog title; kiểm initial focus, Tab/Shift+Tab containment và restore focus,
   giữ Escape priority. Focus management modal hiện tại còn thiếu trong source,
   nên không khẳng định đã bảo toàn khi chưa kiểm.
   Reference: https://www.w3.org/WAI/ARIA/apg/patterns/tabs/

3. **P1 — Không bảo đảm footer trên cửa sổ thấp (30, 200, 359).** Body có
   min-h-[380px] không thể co dưới 380px, cộng header/tab/footer sẽ vượt 90vh
   ở viewport thấp. Dùng min-h-0 flex-1 overflow-y-auto, header/tabs/footer
   shrink-0; quy định chiều cao khả dụng và kiểm screenshot thực. max-w-5xl
   cũng giảm từ max-w-6xl hiện tại: cần kiểm bảng groups, label EN và content dài,
   không mặc định hẹp hơn là tốt hơn. overflow-hidden có thể cắt popover/focus,
   phải thử edit ở sát mép.

4. **P2 — Cảnh báo toàn modal bị giấu (208–219).** loadError và busy/read-only
   hiện ở vùng chung; plan chuyển vào Basic, mất dấu trên hai tab khác. Đặt
   trạng thái chung ngoài hidden panels. Footer compile.saveBlocked nên có
   action chuyển tới Compilation và đưa focus vào field lỗi; lưu vẫn bị chặn
   trên mọi tab. SaveError/confirmation/Escape phải giữ nguyên.

5. **P2 — Summary không phản ánh đầy đủ config (132–139).** totalScore có type
   number|string|null; || làm numeric 0 rơi sang totalPoints, khác quy tắc save
   hiện tại (null/undefined/trim-empty). Dùng cùng điều kiện presence với save,
   tái sử dụng rational formatter khi cần, không parseFloat. Label binary
   Standard/File không mô tả mixed stdin/file-out hoặc file-in/stdout; interactive
   cần label rõ thay vì gộp vào Standard. Loading/error không trình bày 0 tests
   như kết quả đã tải. VI/EN cần các mode này, plural EN nếu dùng count. Không
   sửa save semantics chỉ để đơn giản summary.

6. **P1 — Chưa có regression tests hành vi (351–377).** check:fast/server và
   manual matrix chưa thay thế được test đổi tab. CompileProblemSettings.test.tsx
   hiện chủ yếu SSR/helper; không tìm thấy ProblemConfigModal.test.*. Cần RED/GREEN
   cho custom draft không hợp lệ → chuyển Basic/Tests → vẫn giữ draft, Save disabled,
   không POST/confirm/save; quay lại sửa hợp lệ → save đúng snapshot. Test thêm
   profile/draft, selection/showContent/groups persistence, tab keyboard, popover
   đóng, warning visibility và confirmation khi hasScoredResults. Không viết
   test chỉ match className hoặc source regex để chứng minh state persistence.

7. **P1 — Thiếu bước isolation đã yêu cầu.** Hiện chỉ có worktree gốc trên main,
   HEAD 23290be80111dd9ddf2e58f15006e0f076258eff; chưa có branch/worktree redesign.
   vi.json có thay đổi sẵn, không overwrite. Chốt source nền và worktree riêng
   trước production edits để checkout frontend cũ vẫn dùng hotfix. Không mang
   toàn bộ dirty backend sang nhánh UI hoặc commit hộ nhiệm vụ khác.

## Scope / verification clarification

- Mounted không ngăn mọi effect reset: loaded compile value thay đổi vẫn chạy
  synchronization effect. Test tập trung bảo đảm chuyển tab đơn thuần không reset;
  không quảng cáo giữ mounted như bảo đảm toàn bộ async validation.
- GroupPolicyTable vốn tự return null khi groups off, không có local draft hiện
  tại; conditional bên ngoài là dư nhưng không cùng rủi ro compile unmount.
- Bảng màu mới chỉ đổi modal chrome; children vẫn có indigo/uppercase/type nhỏ.
  Ghi rõ batch này đổi navigation/layout và chrome; polish children là batch
  tiếp theo hoặc mở rộng file scope có chủ đích. Checkbox native dùng accent-color,
  text-green class không đủ đảm bảo màu tick nếu không có forms reset/plugin.
- Link prototype ở dòng 3 sai relative path: từ docs phải là
  verification/frontend-redesign/artifacts/FR1/light-options.html.
- check:fast không xác minh visual/tab behavior. Plan đầy đủ đã yêu cầu
  test:server + test:desktop (khác bản tóm tắt chỉ nhắc check:fast). Thêm focused
  behavioral tests và screenshots Light/Dark × VI/EN × normal/narrow/short;
  group/content, custom-invalid hidden, popover, busy/error và save confirm.
  Restart desktop sau batch vì --no-watch/DISABLE_HMR=true. check:full trước
  commit/push theo AGENTS; không sửa/hạ gate cho dirty changes ngoài scope.

## Suggested execution order

1. Sửa plan theo findings; ghi A đã được người dùng chọn (STATUS cũ còn pending).
2. Chuẩn bị branch/worktree từ source nền đã xác định, giữ checkout hotfix.
3. Focused regression tests RED, implementation nhỏ giữ mounted, GREEN/check:fast.
4. test:desktop, native before/after screenshots, keyboard/contrast/scroll QA.
5. Server/full checks đúng gate, review diff và cập nhật log. Không đánh DONE khi
   thiếu required evidence; phân biệt lỗi môi trường/dirty baseline.

Review-only: chưa chạy runtime gates vì không sửa runtime. Contrast tính bằng
Node built-ins; không thêm dependency. Chỉ thêm tài liệu review, giữ plan gốc.
