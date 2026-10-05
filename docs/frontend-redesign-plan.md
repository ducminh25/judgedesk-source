# JudgeDesk — Frontend redesign có kiểm soát

Ngày bắt đầu: 2026-10-03 (Asia/Bangkok). Trạng thái hiện tại ở
`docs/verification/frontend-redesign/STATUS.md`; lịch sử ở `WORKLOG.md` cùng thư mục.

## Mục tiêu và phạm vi đã được người dùng chốt

Cải thiện giao diện desktop đang bị nhận xét là “AI slop”, giữ các workflow của
JudgeDesk. Light theme là bản thiết kế chuẩn; dark theme dùng cùng cấu trúc,
component và trạng thái với bảng màu được hiệu chỉnh riêng. Đây là redesign từng
phần, không viết lại app hay chuyển stack.

Người dùng cho phép Computer Use khảo sát bản JudgeDesk v1.5.1 đã cài, gồm màn
chính và các modal như Settings, Problem configuration. Sau mỗi đợt chỉnh sửa
frontend phải chạy `npm run test:desktop` và xem UI thực tế. Lượt khởi đầu ưu tiên
tạo plan và khảo sát, chưa thay đổi giao diện sản phẩm.

## Nguồn chuẩn và giới hạn

- `AGENTS.md`, `guidelines.md`, `CONSTRAINTS.md` là chuẩn cao nhất của repo.
- Đọc `docs/UI_UX_DESIGN.md`, `docs/APP_FLOW.md` khi audit; tài liệu và source có
  thể lệch nhau. Ghi nhận lệch trước khi cập nhật tài liệu.
- Giữ scoring rational, sandbox, compiler policy, API/SSE và phân tầng.
- Giữ phiên bản 1.5.1; không sửa riêng một file version.
- Không thêm dependency hoặc font tải từ mạng khi chưa được người dùng cho phép.
- Giữ library icon và primitive hiện có nếu phù hợp; không thay chỉ vì “gu AI”.
- Giữ focus bàn phím, localization VI/EN, theme preference và lỗi có hành động.
- Không gradient trang trí, backdrop blur, glow, pill button hay animation nảy.
- Không sửa migration Rust, backend, native executor, CI hoặc ledger của nhiệm vụ
  khác để làm frontend gate xanh. Các thay đổi đó đang có sẵn trong working tree.

## Cách tiếp tục sau gián đoạn

1. Đọc plan này, `STATUS.md`, rồi mục mới nhất của `WORKLOG.md`.
2. Kiểm tra `git status` và diff của những file frontend dự định sửa. Không reset,
   stash hay ghi đè thay đổi của người dùng/nhiệm vụ khác.
3. Xác định package hiện tại, hành động kế tiếp và evidence còn thiếu từ STATUS.
4. Khi tiếp tục Computer Use, đọc skill/docs và lấy lại window từ inventory mới;
   không dùng handle, screenshot ID hay tọa độ cũ trong log.
5. Xác định đang xem bản cài hay bản dev. Không coi version 1.5.1 trên UI là đủ để
   chứng minh đúng build; ghi path executable và lệnh build/dev.
6. Tiếp tục từ bước chưa hoàn thành, không làm lại các bước có bằng chứng hợp lệ.

## Ledger và bằng chứng

Mỗi package có trạng thái TODO / IN_PROGRESS / VERIFYING / DONE. Chỉ DONE khi có
deliverable và bằng chứng phù hợp. Dùng BLOCKED cho trở ngại thật và ghi rõ cách
gỡ, không ghi PASS khi chưa chạy. Mỗi log ghi: thời điểm, package, hành động,
files sửa, findings, commands/exit code, screenshot paths và bước tiếp theo.

Evidence nằm tại `docs/verification/frontend-redesign/artifacts/<package>/`.
Ảnh đặt tên `<build>-<theme>-<locale>-<screen>-<state>-<size>.png`. Manifest phải
ghi build, theme, locale, kích thước ảnh/cửa sổ, DPI nếu biết, fixture, thao tác tái
tạo và mô tả. Thiếu DPI hay trạng thái nào thì ghi chưa đo, không suy đoán.
Ảnh lưu từ screenshot API chỉ để phục vụ audit/recovery; không chụp app khác.
Không đưa dữ liệu thật của thí sinh vào mockup chia sẻ. Audit dùng contest/fixture
riêng; không ghi đè contest thật, không chấm lại hay xoá điểm thật.

## FR0 — Chuẩn bị và khảo sát baseline

- Ghi HEAD, dirty tree và script desktop hiện tại.
- Mở bản cài bằng Computer Use, kiểm tra tên/version, theme/locale ban đầu và
  trạng thái contest trước khi thao tác; phục hồi theme/locale sau khảo sát.
- Lập inventory màn/modal thực tế. “Settings” cần xác định từ UI; không mặc định
  có một modal tổng hợp nếu app chỉ có menu/preferences/OSD settings.
- Chụp light và dark trên cùng fixture: empty workspace, populated scoreboard,
  hover/selection/focus, menu, in-progress, completed/mixed verdict, errors.
- Khảo sát Problem configuration (limits, tests, groups, checker/interactor),
  judging details/log/diff, directory picker, toolchain manager, OSD settings,
  Help, changelog và các dialog mở/lưu/update/xác nhận khi tái tạo được an toàn.
- Dialog phá huỷ/update chỉ xem rồi huỷ; không kích hoạt xoá dữ liệu, cài update,
  download toolchain hay bật watcher trên thư mục thật.
- Đánh dấu NOT_OBSERVED cho trạng thái chưa tiếp cận được và lý do. Không cố tạo
  lỗi bằng cách phá runtime/toolchain hoặc gây áp lực lên contest đang chạy.
- Chụp kích thước cửa sổ chuẩn và hẹp. DPI 125/150% và macOS kiểm tra khi có môi
  trường; không đổi system settings chỉ để lấy baseline.
- Báo cáo findings có severity, screen, evidence, nguyên nhân dự kiến và hướng
  sửa. Phân biệt quan sát từ UI với giả thuyết từ source.

Đầu ra: baseline manifest + screenshots + audit report + ưu tiên sửa.
Điều kiện chuyển bước: đủ baseline màn chính và modal quan trọng; phần thiếu
được liệt kê để không bị bỏ quên.

## FR1 — Chuẩn thiết kế JudgeDesk và lựa chọn light theme

- Tham khảo `evondev/evondevKit`, skill `skills/ui-ux`, không chạy script remote
  hay cài nguyên bộ tự động. Ghi commit tham chiếu khi nhập nội dung và giữ MIT
  attribution/license cho phần sao chép.
- Lấy audit/reuse, wireframe, app layouts, states và Tailwind v4 traps. Loại luật
  I13/I14 ẩn focus mặc định; thay light-only bằng trách nhiệm hỗ trợ hai theme.
- Tạo `judgedesk-frontend` với contract desktop, mật độ dữ liệu, VI/EN,
  accessibility, offline assets, visual QA và test:desktop.
- Điều chỉnh dispatch/skill thiết kế cũ để một task có một hướng dẫn thiết kế
  chủ đạo, không nhận các chỉ dẫn landing page, glass/gradient hoặc đổi icon.
- Tạo hai phương án light cho cùng màn chính + một Problem config đại diện,
  cùng dữ liệu và workflow. So sánh hierarchy, mật độ, số thao tác, readability.
- Hướng đề xuất: bảng trung tâm, toolbar phân nhóm, primary action rõ, surface
  trung tính, màu semantic tiết chế, border 1px, radius nhỏ, số tabular.
- Trình bày phương án xem được trước khi yêu cầu lựa chọn cho rollout rộng.

Đầu ra: light direction cụ thể + design decisions + skill có phạm vi rõ.
Các con số typography/density chốt sau audit; không lấy mặc định từ skill ngoài
làm tiêu chuẩn ép mọi màn. Dark mapping tạm thời tồn tại ngay khi sửa token.

## FR2 — Token và primitive

- Audit primitives/callers trước khi tạo helper/component.
- Chuẩn hoá semantic tokens: canvas, surface, overlay, border, text, accent,
  success/warning/danger, hover/selected/focus/disabled; light/dark cùng tên.
- Chốt spacing, type, control height, radius và shadow cho lớp nổi.
- Chuẩn hoá các control được tái sử dụng thực tế; không xây framework UI mới.
- Giữ hành vi modal: focus, restore focus, Esc, unsaved data, scrolling.
- Tạo mẫu kiểm tra gọn, dùng cơ chế sẵn có; không tự thêm route/debug surface
  production chỉ để có trang design system.

Đầu ra: token/primitive dùng thực tế + desktop screenshots và checks.

## FR3 — Light: màn chính

Toolbar, scoreboard, progress/status, context menu, empty/loading/error.
Giữ sorting, selection, keyboard navigation, sticky columns/header, score
details, action availability và updates trong khi chấm. Dùng mixed verdict,
tên dài, nhiều hàng/cột và tổng điểm để kiểm tra màu và density. Không giảm số
dữ liệu nhìn thấy chỉ để tạo nhiều khoảng trắng.

## FR4 — Light: cấu hình và kết quả

Problem config + test/group tables + checker/interactor controls; judging
details, logs, diff viewer. Kiểm tra dữ liệu dài, form validation, footer luôn
truy cập được, unsaved confirmation và thao tác bàn phím.

## FR5 — Light: các màn phụ

Directory picker, toolchain manager/prompts, OSD settings, contest dialogs,
Help, changelog, update/donation dialogs. Migrate theo nhóm nhỏ, kiểm tra bằng
cùng token và primitive; tránh đổi workflow ngoài mục tiêu đã chốt.

## FR6 — Dark và parity

Hiệu chỉnh dark palette trên cùng component/layout đã ổn ở light. Kiểm tra
surface layering, muted text, borders, verdict, selection/focus, modal/menu,
disabled và error. Không đảo màu tự động hoặc dùng hai bộ markup riêng.
Hoàn tất matrix light/dark × VI/EN × normal/narrow; kiểm DPI và macOS khi có.

## FR7 — Nghiệm thu và handoff

- Review correctness, maintainability, architecture, security và performance.
- Chữ thường tối thiểu 4.5:1; chữ lớn 3:1; focus/control thiết yếu 3:1 ở trường
  hợp áp dụng. Kiểm cả foreground/background semantic states.
- Navigation bàn phím có dấu focus; màu không là dấu hiệu duy nhất của verdict.
- Không horizontal overflow của app shell ngoài vùng cuộn bảng/log chủ đích.
- Đo scroll/update/resizing trên fixture cố định trước/sau nếu nghi regression;
  không thêm animation/re-render nặng vào hot path scoreboard.
- Cập nhật `docs/UI_UX_DESIGN.md` theo thiết kế cuối, giữ audit/evidence.
- Handoff liệt kê phần hoàn thành, thiếu, rủi ro và bước tái kiểm tra.

## Vòng kiểm tra bắt buộc cho mỗi đợt sửa frontend

1. Chụp/đọc baseline của vùng đang sửa; ghi files và behavior cần bảo toàn.
2. Nếu đổi logic/hành vi: áp dụng TDD, test thất bại trước fix; styling thuần
   dùng visual QA, không viết test chỉ sao chép className.
3. Sửa một nhóm nhỏ; chạy `npm run check:fast` và tests liên quan.
4. Chạy `npm run test:desktop`. Script hiện tại DISABLE_HMR=true và --no-watch:
   bản dev cần restart sau đợt sửa, không giả định UI đã hot reload.
5. Chọn đúng window dev bằng Computer Use; xác minh build, thao tác và chụp
   cùng states/fixture/size cho trước-sau; sửa rồi lặp lại nếu còn lỗi.
6. Ghi log command/build failure và thiếu screenshot. Server PASS không thay
   cho visual QA; browser preview không thay cho desktop theo yêu cầu người dùng.
7. Chạy `npm run test:server` trước kết thúc implementation package; `check:full`
   trước commit/push/release. Rust test khi thực sự chạm Rust (không thuộc scope).
8. Gate fail từ dirty tree có sẵn: xác minh bằng evidence, ghi riêng, không
   hạ chuẩn hoặc tự sửa nhiệm vụ migration. Không đánh package DONE khi thiếu
   relevant required checks.

Không chạy build/test nặng chỉ để xác nhận tài liệu plan; ghi rõ documentation
review và runtime chưa thay đổi. Trước desktop build đọc lại migration STATUS
và scripts để tránh va chạm output/artifact đang có owner khác. Nếu có va chạm,
chọn checkout/output riêng đã kiểm tra thay vì thay build policy hay reset tree.
