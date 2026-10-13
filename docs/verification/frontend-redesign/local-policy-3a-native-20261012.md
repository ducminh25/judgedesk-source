# Local policy 3A — native observations

Windows host, 2026-10-12 Asia/Bangkok. Dev executable:
`D:/Minh/Code/judgedesk/src-tauri/target/debug/themis-v2.exe`.
App1.5.5 / HEAD938044e104755965e6c932fd12da79c019077d5a / dirty / local.
Normal builtAt2026-10-12T07:21:31.658Z, backend52038; narrow
builtAt2026-10-12T07:28:49.125Z, backend51756. Both were restarted with
`npm run test:desktop` (DISABLE_HMR=true / --no-watch). Narrow used the owned
960x600 client config; captured images962x631 include native frame. Normal
captures1536x792. DPI not measured; macOS NOT_RUN; no comparable before build.

Owned AppData fixture: `artifacts/local-policy-ui/`, policy schema1/true and
remembered C++ path C:/Themis/GCC/bin/g++.exe, initially mode none. No real
contest loaded or judged. No downloads, installs, manual Verify, security toggles
or real user compiler preferences changed. Theme/locale restored dark/VI.

## Observed workflow

- F6 shows legacy-policy-disabled notice, without a weaker-isolation control.
- Changing C++ none -> local_path shows pending discovery then automatically
  incompatible, without Self-Test. Path/source remain selected, no fallback.
- Read-only GET of the owned backend confirms selected GCC9.2.0/target mingw32,
  roles false, probe incompatible: Windows623 ERROR_ILLEGAL_DLL_RELOCATION at
  sandbox launch. Local Python diagnostic: exited0xC0000022. These observations
  are not a proven root cause or a universal incompatibility claim.
- Host Tools menu reflects unavailable local tools after completion. This is
  a negative-path UX observation, not a successful real compiler probe.
- Notice fits VI/EN light/dark, normal/narrow. Body scroll and close footer remain
  reachable. Toolbar narrow requires horizontal scroll to reach Tools; changing
  language can move it outside the viewport again. Existing behavior, not fixed.
- F6/Escape observed; Tab from selected source visibly focuses/selects the path
  input. Accessibility focus metadata reported the document, not the input.
  Manager has no complete focus trap/return-focus proof. Existing menu may stay
  above manager when F6 is used while menu is open; close menu to inspect notice.
  No comprehensive accessibility PASS.
- Both dev windows closed normally via Alt+F4; both sessions exit0, sidecar code0.

## Screenshot manifest

Audit directory: `artifacts/local-policy-20261012/` relative to this document.
Recreate: owned fixture -> F6; switch display via Tools -> manager; restore
dark/VI. Notice-only states below use selected local_path except first dark VI.

| File | Theme | Locale | Image | SHA-256 |
| --- | --- | --- | --- | --- |
| dev-dark-vi-manager-legacy-stable-normal.png | dark | VI |1536x792|9573cdaf2c31866dc3066e3e111fb52a1ff386be972006d80f3258e306688090|
| dev-light-vi-manager-legacy-normal.png | light | VI |1536x792|b4fd58851586bd970fbef3a9bb53c35c9ea5cf8cc3e8797a737dbe4ef91c47f2|
| dev-light-en-manager-legacy-normal.png | light | EN |1536x792|cb24ee0f49ccc473f5b9dd8fcb0b8e31a6784d2ae060bf6cb8ccee5359a51257|
| dev-dark-en-manager-legacy-normal.png | dark | EN |1536x792|0d39d6d67792ff01a63b57b57129a1b6281922dbe5f524c0bc553cd4c6acaef0|
| dev-dark-en-manager-legacy-narrow.png | dark | EN |962x631|f3fe95861f21bbd743eb0a84d070beadb141365e02aa5b52bdf7d6229cc36483|
| dev-light-en-manager-legacy-narrow.png | light | EN |962x631|794c73c9501bf8fc91237716aba3ac22917065d33d164b0dd10e621b27f3ebe7|
| dev-light-vi-manager-legacy-narrow.png | light | VI |962x631|dedf5324064588585383a653472f2aa5d14d9c445ea4c2045f21d0b76271ab5d|
| dev-dark-vi-manager-legacy-narrow.png | dark | VI |962x631|33006156fe7952694e4bebc35957197240cef3d974476aa58a30a629641f3b8f|

Additional normal darkVI: probe-pending SHA891a3944d30442cebc6c5882fdef6dae9da513f5b2c780e628c28caf354cd801;
probe-failed SHA02d8eb1335ffe87e2a9cc5f0d607b6619a16de15beb499ebfd8830bbe4e5490e.
Initial dev-dark-vi-manager-legacy-normal frame not used for acceptance: displayed
capture appeared transitional; retained for audit, use stable-named observation.

Contrast: static source-palette clipped-sRGB estimate only, not sampled text or
computed native CSS. Uses Tailwind amber800 on amber50; dark amber300 on
amber950/30 over --surface#09090b. No claim of full app/control contrast acceptance.
Estimated ratios: light 6.877:1, dark 13.049:1. These are source-palette estimates,
not a measured native-text/control accessibility result.

3A functional/gate verification closed with these explicit UX limits. Step3B
still required before compiler readiness includes generated submission/checker.
