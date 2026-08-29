# UI/UX Design System & Specification — JudgeDesk

**Project Name**: JudgeDesk  
**Document Status**: Official / Approved  
**Classification**: Internal UI/UX Design Guide  

---

## 1. Design Principles & Goals

1. **Efficiency First**: Contest organizers and teachers under high-pressure exam environments need instantaneous feedback, zero distraction, and full keyboard-driven workflows (`F1`-`F12`).
2. **Clear & Actionable Diagnostics (No Silent Errors)**: Every warning or failure must be explicit, transparent, and follow the **3-Part Error Rule** (*What happened*, *Why it happened*, *Clear action*).
3. **Data Clarity & Information Hierarchy**: High-density matrix scoreboard with clear visual cues (color-coded verdicts, status badges, natural alphanumeric ordering).
4. **Accessible & Responsive Dark/Light Themes**: Fluid adaptive palette built on Tailwind CSS v4 CSS variables with high contrast ratios for projector displays and low-light grading sessions.

---

## 2. Color Palette & Design Tokens

JudgeDesk uses CSS semantic tokens configured in Tailwind CSS v4:

| Semantic Token | Light Mode Value | Dark Mode Value | Usage |
| :--- | :--- | :--- | :--- |
| `--bg-surface` | `#ffffff` | `#0f172a` (Slate 900) | Primary application background |
| `--bg-surface-elevated` | `#f8fafc` (Slate 50) | `#1e293b` (Slate 800) | Toolbars, table headers, dialog headers |
| `--bg-surface-hover` | `#f1f5f9` (Slate 100) | `#334155` (Slate 700) | Hovered table rows, interactive buttons |
| `--border-surface-border`| `#e2e8f0` (Slate 200) | `#334155` (Slate 700) | Container borders, table grid lines |
| `--text-primary` | `#0f172a` (Slate 900) | `#f8fafc` (Slate 50) | Main headings, contestant names, scores |
| `--text-muted` | `#64748b` (Slate 500) | `#94a3b8` (Slate 400) | Subtitles, path labels, metadata text |
| `--color-accent` | `#4f46e5` (Indigo 600) | `#6366f1` (Indigo 500) | Primary CTA buttons, active tabs, focus ring |
| `--color-success` | `#16a34a` (Green 600) | `#22c55e` (Green 500) | Accepted (`AC`) cells, 100% scores, ready badges |
| `--color-warning` | `#d97706` (Amber 600) | `#f59e0b` (Amber 500) | Partial scores, OSD queue active, warnings |
| `--color-danger` | `#dc2626` (Red 600) | `#ef4444` (Red 500) | `WA`, `TLE`, `MLE`, `RTE`, `CE`, critical errors |

---

## 3. Typography & Micro-copy

* **UI Font Family**: Inter, system-ui, `-apple-system`, BlinkMacSystemFont, "Segoe UI", Roboto.
* **Monospace Font Family**: `JetBrains Mono`, `Fira Code`, `Consolas`, `ui-monospace`. (Used for file paths, test case IDs, time/memory readouts, and compiler diagnostic logs).
* **Bilingual Micro-copy Standard**:
  * All user-facing strings must reside in `src/locales/vi.json` and `src/locales/en.json`.
  * Technical exception codes must be localized via human-friendly descriptions rather than raw runtime names.

---

## 4. Key Component Anatomy

### 4.1. AppToolbar (`src/components/AppToolbar.tsx`)
The top toolbar serves as the mission control for contest grading:
1. **Primary Actions**:
   * *Load Problems* (`F2`) & *Load Contestants* (`F3`) with path tooltips and loaded counts.
   * *Reload Folders* (`F5`) to refresh filesystem changes.
   * *Toolchain Manager* (`F6`) with real-time health indicator.
   * *Start / Stop Judging* (`F9`) with prominent accent styling.
   * *Export Excel* (`F12`) with sheet preview icon.
   * *OSD Online Judge* (`F8`) with live pulsing indicator and active queue count.
2. **Contest Context & File State**: Displays active archive filename with dirty indicator `*` when uncommitted score changes exist.
3. **Utility Controls**: Help (`F1`), In-app Update status chip, Donation button, Theme selector, Language toggle (VI/EN).

### 4.2. Matrix Scoreboard (`src/features/scoreboard/Scoreboard.tsx`)
* **Sticky Headers & Columns**: Contestant column remains pinned during horizontal scrolling; problem header row remains pinned during vertical scrolling.
* **3-State Dynamic Sorting**: Toolbar toggle button and Total Score column header click cycle through:
  1. *Score High to Low* (Điểm cao $\rightarrow$ thấp): Top performers first; tie-breaks resolved alphabetically (A-Z); unscored contestants placed at the bottom.
  2. *Score Low to High* (Điểm thấp $\rightarrow$ cao): Ascending order; unscored contestants placed at the bottom.
  3. *Default Order* (Mặc định): Natural alphanumeric sort by contestant directory name.
* **Cell Verdict Coding**:
  * `100.00` / Full score: Emerald background badge.
  * `> 0.00` / Partial score: Amber background badge.
  * `0.00` / Zero score: Rose background badge.
  * `...` / In progress: Indigo pulsing badge.
  * `-` / Unjudged: Neutral text.
* **Quick Interactions**: Click cell to inspect full testcase logs; right-click / action button to delete cell score or re-grade single problem.

### 4.3. 3-Part Error Toast & Banner (`src/components/AppErrorToast.tsx`)
All errors in the application follow the 3-Part Error UX standard:

```
┌────────────────────────────────────────────────────────────────────────┐
│ [!]  Không thể mở bảng điểm Excel                        [X]           │
│      What: Đã có lỗi xảy ra khi khởi chạy phần mềm đọc bảng tính.      │
│      Why: File bảng điểm có thể đang được mở trong ứng dụng khác hoặc  │
│           máy tính chưa có phần mềm đọc file .xlsx.                   │
│      ----------------------------------------------------------------- │
│      -> Hãy đóng file Excel đang mở và thử xuất lại.   [Thử Lại]       │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

* **Visual Anchors**: Alert circle icon, high-contrast colored left border.
* **Dismiss Controls**: Close button `(X)`, auto-dismiss timer on warning/info, `pause-on-hover` behavior.
* **Direct CTA Button**: Provides one-click action to resolve the issue (e.g. *[Load Contestants]*, *[Open Toolchains]*, *[Retry]*).

### 4.4. Problem Configuration Modal (`src/components/ProblemConfigModal.tsx`)
* **Basic Tab**: Time limit (ms), Memory limit (MB), I/O redirection, standard/custom checker selection.
* **Polygon Subtasks Tab**:
  * Group creation, testcase assignment checkboxes.
  * Dependency graph builder with real-time cycle detection and visual alerts.
  * Group scoring mode (Sum of test points vs. All-or-nothing group score).
* **Compile Settings Tab**: Preset selector (Themis compatibility, C++17, C++20, Custom flags) with sanitized flag validation.

### 4.5. Offline Help Center (`src/features/help/HelpCenter.tsx`)
* Launched via `F1` or Toolbar button.
* Full-text search with instant highlight.
* Dedicated topic anchors: Keyboard Shortcuts, Themis Compatibility, Subtasks & Checkers, Online Judge (OSD), Toolchains & Compilers, Scratch Submission Guide (`.sb3`, `.sb2`), and Changelog History.
* **Diagnostics Exporter**: Generates copyable, sanitized system report (OS, CPU, memory, toolchain versions) with zero source code or private path leakage.

### 4.6. Streamlined Fast In-App Update Experience (`src/features/updates/UpdateDialogs.tsx`)
* **Toolbar Update Indicator**: High-visibility pill badge on top toolbar displaying *«Update»* with 1-click trigger.
* **Core Update Priority**: Highlights **Core (Fast Update ~20 MB)** with the green `Recommended` badge.
* **Zero Fear Messaging**: Clear reassurance that all existing compilers, custom paths, and configurations are safely preserved during the fast 3-second update.
* **Progressive Feedback**: Real-time percentage progress bar during download followed by an instant *[Restart Now]* prompt.

---

## 5. Keyboard Navigation & Shortcuts Standard

| Key Binding (Windows) | Key Binding (macOS) | Action | Scope |
| :--- | :--- | :--- | :--- |
| `F1` | `F1` | Open Offline Help Center | Global |
| `F2` | `F2` | Open Problem Folder Picker | Global |
| `F3` | `F3` | Open Contestant Folder Picker | Global |
| `F5` | `F5` | Reload Contest Directories | Global |
| `F6` | `F6` | Open Toolchain Manager | Global |
| `F8` | `F8` | Toggle / Open OSD Online Judge | Global |
| `F9` | `F9` | Start Batch Judging | Global |
| `F12` | `F12` | Export Scoreboard to Excel | Global |
| `Ctrl + N` | `Cmd + N` | New Contest Workspace | Global |
| `Ctrl + O` | `Cmd + O` | Open `.judgedesk` Contest Archive | Global |
| `Ctrl + S` | `Cmd + S` | Save `.judgedesk` Contest Archive | Global |
| `Ctrl + Shift + S` | `Cmd + Shift + S` | Save Contest As... | Global |
| `Ctrl + A` | `Cmd + A` | Select All Contestants | Global |
| `Ctrl + D` | `Cmd + D` | Deselect All Contestants | Global |
| `Ctrl + I` | `Cmd + I` | Invert Contestant Selection at Cursor | Global |
| `Ctrl + Shift + A` | `Cmd + Shift + A` | Select All Problems | Global |
| `Ctrl + Shift + D` | `Cmd + Shift + D` | Deselect All Problems | Global |
| `Ctrl + Shift + I` | `Cmd + Shift + I` | Invert Problem Selection at Cursor | Global |
| `Arrow Keys` | `Arrow Keys` | Move Scoreboard Cursor | Scoreboard |
| `Space` | `Space` | Toggle Selected Row / Column Checkbox | Scoreboard |
| `Enter` | `Enter` | Open Testcase Details Modal for Focused Cell | Scoreboard |
| `Escape` | `Escape` | Close active modal dialog / popup | Modal |

