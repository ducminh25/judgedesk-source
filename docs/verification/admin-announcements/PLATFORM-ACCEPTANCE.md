# Announcement platform acceptance

Updated: 2026-10-24. This matrix covers the new announcement implementation only. Historical JudgeDesk package acceptance does not transfer to a package containing new native/UI code.

## Native development evidence

| Host / engine | Current evidence | Limits |
| --- | --- | --- |
| Windows / WebView2 | 50 announcement Rust tests, Clippy; native binary 4MiB/PNG IPC; eight theme/language/layout UI combinations; normal development app started with healthy Rust backend | QA uses fixture content and real IPC; no production signed feed delivery claim |
| Linux / WebKitGTK 2.52.6 in Ubuntu 24.04 WSLg | 49 announcement Rust tests, all-targets Clippy; native binary/PNG IPC; eight UI combinations; native fixed-endpoint HTTPS probe | WSLg driver warnings retained; not physical Linux desktop or installed-package certification |
| macOS / WKWebView | Not run: no macOS host available in this session | Linux WebKitGTK does not substitute for WKWebView |

Eight UI combinations mean normal 1280×800 and narrow 760×640 × VI/EN × light/dark. Assertions cover no automatic opening/read, anchor bounds, row-menu arrow navigation, Escape order, article image/text, inert background, Tab/Shift+Tab containment and selected-row return focus. Browser screenshots are layout evidence, not native engine certification.

## Installed package matrix

| Package | Core | Full | Current blocker |
| --- | --- | --- | --- |
| Windows installer / WebView2 | Pending | Pending | Candidate containing final production trust has not been built/installed |
| macOS package / WKWebView | Pending | Pending | Final production trust and macOS build/test host required |
| Linux deb / WebKitGTK | Pending | Pending | Final production trust; fresh package install/upgrade evidence required |
| Linux rpm / WebKitGTK | Pending | Pending | Final production trust; fresh package install/upgrade evidence required |
| Linux AppImage / WebKitGTK | Pending | Pending | Final production trust; fresh package/portable data-root evidence required |

None of these ten cells is marked passed. Before distributing a candidate, record its source commit, edition, artifact hash, OS/engine version and app-data root resolution without publishing private machine paths. Build candidates after final trust provisioning so the evidence applies to the exact shipped bytes.

For each cell verify: clean first launch; signed feed fetch; offline restart with cached list/article/media; explicit reload failure preserving content; read/unread/delete and restart; same-UID edit preserving state; new UID unread; expiration/withdrawal; Core↔Full switch and upgrade preserving state; article close cancelling network; menu/modal keyboard behavior; VI/EN and both themes at both sizes. Recheck judging availability and update handoff while announcements are open. Use isolated test data, not student submissions or a production signing private key in the test app.

## Reproduction and acceptance rules

Focused native commands use `--locked`; Clippy uses `--all-targets -- -D warnings`. Windows commands require the documented Visual Studio developer environment. The QA example `src-tauri/examples/announcements_webview_qa.rs` is separate from the production executable and includes no trusted-key override. Its local page is an ignored test artifact; keep its server alive and verify the page HTTP 200 before launch. Windows example linking additionally needs the adjacent Common Controls manifest (the production app already has Tauri resources).

Native GUI acceptance requires an explicit `ANNOUNCEMENT_WEBVIEW_QA` JSON report with `passed: true` and all expected combinations. A timeout, missing report or process exit alone cannot pass this gate. One Linux attempt had a stopped server and timed out; it is preserved in `artifacts/linux-final-integrated.log`. A restored server produced the separate passing `artifacts/linux-webview-qa-eight-states.log`.

After the final empty-panel focus fix, reruns use separate QA browser profiles and require the new focus assertion as well as the eight combinations. This caught a cached older HTML/bundle report that otherwise still said `passed: true`; that earlier report was not accepted for the changed source. Final logs are `artifacts/windows-webview-qa-focus-fresh-profile.log` and `artifacts/linux-webview-qa-focus-fresh-profile.log`, summarized in `native-webview-results.json`. The profiles are confined to ignored QA artifacts; user/browser data was not deleted. Windows ran a byte-for-byte copy of the already-built manifested QA executable outside Cargo's output directory to avoid locking a target binary during other verification.

Fixed-endpoint HTTPS probes can prove TLS/transport but HTTP 404 cannot prove feed readiness. No certificate bypass, plain-HTTP production fallback, alternate endpoint, system proxy feature or unconfigured signing-key fallback is permitted. Live signed Pages verification remains P8.
