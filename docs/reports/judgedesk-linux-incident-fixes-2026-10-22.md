# Linux incident fixes — 2026-10-22

Scope: implement the fixes established in [the tester audit](judgedesk-linux-tester-audit-2026-10-22.md), using independent self-review and regression tests. No outside reviewer/model was used. This is a local QA build, not a published release or Full edition. Version remains 1.6.0. Existing changes in the working tree were preserved.

## Changes and reasoning

### Host applications launched from AppImage

The AppImage launcher changes library and module search paths for its own GTK/WebKit runtime. Passing those paths to host LibreOffice, Flatpak or other desktop applications mixes incompatible libraries. The original Fedora loader reproduction produced the same missing `nghttp2` symbol as the tester's screenshot.

The packaging step now captures the incoming host environment immediately after the outer Bash AppRun shebang, before linuxdeploy's GTK hook and wrapped launcher. One shared JSON contract lists the affected variables, including `PERLLIB` and `GST_PLUGIN_SYSTEM_PATH_1_0`, verified against the actual packaged launcher. Separate presence flags preserve unset versus empty variables. Values are copied without shell evaluation.

Rust and Node restore that environment only for host desktop processes. The application keeps its bundled GUI environment; DISPLAY, Wayland and session D-Bus values are preserved. Linux directory picker, workbook opener, checker preview and external URL callers share this policy. The custom Tauri URL command retains the exact existing capability allowlist.

The staged AppDir is repacked with Tauri's existing AppImage output plugin. linuxdeploy is not run a second time. Final package checks confirm the snapshot precedes AppRun hooks, Scratch bytes remain pristine and all packaged ELFs meet the established GLIBC baseline.

### Failed checker execution must not become WA

Bubblewrap reports a child PID before executing the target. Its own exit 1 is not sufficient evidence that a checker returned exit 1. Normal strict completion now requires a valid final payload status; missing or malformed status becomes a launch/environment error. This also covers the interactive sibling path.

A real checker returning 1 still means WA. The guard respects resource-limit and cancellation precedence, and intentional interactive peer termination. It does not infer verdicts from stderr text or automatically choose another compiler.

Regression tests first reproduced a missing-interpreter checker as `Exited(1)`, then verified `LaunchError` after the fix. They also exercise submissions, an invalid interactive participant, a valid WA checker, status parsing and drained active-run state. Existing full native/core tests cover scoring, checkers, cancellation, limits and interactive execution.

### Saving and opening a workbook are distinct outcomes

Both backend routes now return `saved`, `openStatus`, `openError` and the saved workbook/diagnostic paths. Failure to start the viewer no longer discards the successful save outcome. Golden API fixtures and the documented response contract were updated; both adapters continue to be checked against the same contract.

Desktop launch observes early process failure for a bounded 250 ms interval. Long-lived viewers are reaped in the background rather than holding the HTTP request until the user closes them. Stderr collection is bounded and continues draining. `launched` means process handoff, not proof that a window rendered; failures after the observation window are logged.

The frontend shows a persistent, localized recovery message with the saved file path and a copy-path action. Long paths wrap. Clipboard failure retains the visible location. Node and Rust route regressions verify the saved bytes and diagnostics survive viewer failure.

### Portable stress expectations

The external `stress_test_judge` suite now includes Linux for its portable cases. The two Windows PE checker cases explicitly expect JE on Linux rather than accepting a false WA. Windows/macOS expectations were retained. Missing or sandbox-incompatible toolchains are reported BLOCKED only when an explicit environment diagnostic and zero executed tests establish that condition; they cannot be counted as PASS. OS-specific exploratory security applicability was not broadened.

The expectation helper tests and fixture validation passed. Source expectations were backed up before editing. No scoring implementation or compiler/PCH flags were changed by this incident fix.

## Build identity

- Build number: `qa-linux-fix22-1c8c78e778c451f5`.
- Source SHA-256 manifest digest: `1c8c78e778c451f5c7cddcc5073378abc662ed83a43c5d78fb8ec65b02f1d357` (1,018 files, raw bytes checked before and after copying).
- Commit base: `e70dcbfb7cae54df5ab28cc5f88cdd1dd67c305f`, dirty source snapshot.
- Build timestamp: `2026-10-22T08:29:58.194Z`.
- Build userspace: Ubuntu 22.04, locked Node/npm/Rust/Tauri CLI; existing build caches reused.
- Windows executor rebuilt and retained its literal approved SHA-256 `a7de861154753ab6a05fb455f2e908256d0994d09fe5aec14573b366dad3b182`, 965,120 bytes. Only the source freeze record was refreshed; its independent identity pins were not relaxed.

| Installer | SHA-256 | Bytes |
| --- | --- | ---: |
| DEB | `c09983dc775bcc0b0033084e86d666bd7ea209dbd1b1da1b25fae274174f3307` | 83,890,138 |
| RPM | `09bd47bbf56fc8e0f5a6e52056794d401954cdb4c316489b59702d8f469f6c47` | 83,890,591 |
| AppImage | `a9ec22b2aaca93203b9d020ec1baf2cc93bab7841ee7478db9ef3d5c25e87a9e` | 153,422,328 |

Candidates and their SHA256SUMS/identity file are in `artifacts/linux-fixes-20261022/installers/`. The earlier tester candidate remains available separately.

## Verification record

- Linux packaging regressions: PASS, including actual AppRun environment capture, inert shell-special values, pristine Scratch and damaged payload rejection.
- Linux Rust gates: **9/9 PASS** (fmt, Clippy with warnings denied, and tests for native executor, core, Tauri). Final log: `linux-gates-verified.log`.
- Focused API contract group through the repository runner: **50/50 PASS**.
- Windows `npm run check:full`: **PASS**, including 9/9 Rust gates, 978 discovered tests (968 pass, zero fail, 10 existing platform-conditional skips), four-tier 67-fixture checker parity and eight-file version lockstep at 1.6.0. Log: `windows-full-final.log`.
- Installed RPM on Fedora 44: six sandbox toolchain diagnostics, six AC submissions, host-loader/export handoff/failure checks and clean shutdown **PASS**.
- AppImage on Ubuntu 22.04: the same six-toolchain and export checks, plus clean shutdown **PASS**; no caller graphics workaround flags supplied.
- AppImage on Fedora 44: **137/137 portable stress cases PASS**, zero blocked/failed, including exact rational 1/3, the two PE checker JE cases, valid AC/WA/PE checkers and all Scratch cases. Six sandbox diagnostics/AC submissions, host-loader/export checks and clean shutdown also **PASS**.
- DEB on Ubuntu 22.04: the same six-toolchain and export checks **PASS**. The first full stress run under concurrent build/test load returned **135/137**, with two MLE fixtures hitting the unchanged 1-second wall deadline before reaching their 1 GiB memory limit. Evidence retained; this run is not counted as a full pass. Both unchanged fixtures passed in an idle DEB retest (**2/2**, all ten testcase outcomes MLE), without changing the 1 GiB/1-second limits or expectations. This is separate evidence, not a rewritten 137/137 first run. Logs: `deb-ubuntu22/stress-run.json`, `deb-ubuntu22-mle-idle/stress-run.json`.
- Native packaged AppImage UI: recovery verified in English/Vietnamese and light/dark, maximized and at restored approximately 1024px width. The saved path wraps, the recovery action remains visible and copying/pasting yields the saved `Book.xlsx` location. WSLg capture required fresh observations after input and single-window isolation. The bounded QA session ended before an additional frontend workbook copy could be preserved; automated API byte-retention evidence is available. Details: `appimage-ubuntu22-ui/ui-verification.json`.
- All completed package acceptance scopes report acknowledged backend shutdown, zero native descendants after drain and zero remaining processes.

Final diff review normalized CRLF to LF in five edited TypeScript/JSON files; content was otherwise identical. Their before/after hashes are in `post-qa-normalization.json`. The installer source manifest remains the exact historical build snapshot; subsequent verification documentation and line-ending normalization do not change its provenance.

Evidence root: `artifacts/linux-fixes-20261022/`. Initial failed gate logs were retained. The source freeze/golden fixture failures were fixed through intentional contract updates. Linux harness failures were diagnosed as missing explicit executor/esbuild locations when using a Linux-native Cargo target with a Windows checkout; the final run uses the existing Linux binaries. One Linux-only Clippy needless-return warning was corrected without suppression.

Packaged export acceptance uses a controlled viewer process to exercise successful handoff and early exit 127. That process invokes the real host `/usr/bin/curl --version`; the test checks it links successfully, bundle metadata/search paths are removed, session values and original PATH survive, and the saved real XLSX and diagnostics retain their bytes. This is fault injection in the acceptance harness, not a production test bypass or proof of a LibreOffice window opening.

## Limits before Full

WSL shares the Windows machine's CPU, RAM and kernel. It is valuable for package, API and sandbox regression testing, but does not reproduce a physical Fedora/Ubuntu graphics stack. Native Linux desktop rendering and the recovery UI need to be described separately from automated API results. A short physical-tester AppImage export/open check remains useful.

Windows compilation and runtime gates passed. Native macOS execution was not available in this session; its opener arguments and environment behavior were preserved, and no cross-platform compiler or scoring policy was changed by this incident fix.

The Ubuntu 22.04 QA environment has the previously documented Bubblewrap/CPU-delegation preparation. It does not certify an untouched Ubuntu installation. The baseline report's prerequisites remain release work: stock Bubblewrap 0.6.1 lacks the required `--size` support, and default systemd user CPU delegation needs a supported solution. Sandbox isolation must remain fail-closed.

These fixes do not make AppImage run on every distro or supply missing Java/Pascal installations. Full toolchain manifest, licensing, ABI, verified atomic extraction, compiler/PCH identity, update/rollback and storage policy remain a subsequent research task. Full bundling has not been implemented.
