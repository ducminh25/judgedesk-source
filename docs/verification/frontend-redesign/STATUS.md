# Frontend redesign — Trạng thái tiếp tục

Updated: 2026-10-03 (Asia/Bangkok).
Plan: `../../frontend-redesign-plan.md`.

| Package | Status | Evidence |
|---|---|---|
| Plan/recovery setup | DONE | Plan, STATUS, WORKLOG, BASELINE |
| FR0 baseline audit | DONE (representative) | 33 PNG; AUDIT.md + manifest; remaining coverage tracked |
| FR1 design/skill | IN_PROGRESS | Project skill + DESIGN.md + interactive HTML A/B; preference/render QA pending |
| FR2 tokens/primitives | TODO | |
| FR3 main light UI | TODO | |
| FR4 config/results light | TODO | |
| FR5 secondary light | TODO | |
| FR6 dark/parity | TODO | |
| FR7 final acceptance | TODO | |

## Hành động tiếp theo

FR1: xem DESIGN.md và prototype artifacts/FR1/light-options.html; chọn A/B hoặc
điều chỉnh trước rollout. A được đề xuất. Browser file preview bị policy chặn;
không có render QA hay ảnh FR1. Skill validator thiếu PyYAML; chưa cài dependency.
Đọc AUDIT.md và manifest trước khi lặp khảo sát. EN/narrow/focus/contrast và modal
parity còn thiếu, bắt buộc trước acceptance (không tính PASS).
App đang light/VI, thihay copy 15x5 chưa chấm, modal đóng; OSD off.
Stress đã lưu riêng tại D:\Minh\Code\judgedesk-ui-audit\20261003\stress-baseline.judgedesk.
Reacquire window từ sky.list_windows; không dùng handle/index từ phiên trước.

## Workspace và gate

HEAD ban đầu: `8bc8ac9a2161a7468b633c421185d039c97e5a68`.
Source version: 1.5.1. Working tree có nhiều migration changes có sẵn.
Installed UI: v1.5.1 · 4d6c068324a3 · build local; executable
`C:\Program Files\JudgeDesk\themis-v2.exe` (khác source HEAD).
Không commit/stash/reset; không sửa các ledger/artifacts pure-rust-core.
`test:desktop` có build:server, prepare-desktop-dev, DISABLE_HMR=true, --no-watch.
Chưa chạy runtime gates: lượt này tạo tài liệu và khảo sát bản cài.
