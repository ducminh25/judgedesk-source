# Native regression: nested Escape ownership

RED observed 2026-10-07 in Windows test:desktop, base 23290be + modal changes.

1. Load copied stress fixture; open A_plus_B configuration.
2. Open Testcases & groups, then first testcase Points popup.
3. Press Escape once.
4. Expected: popup closes, configuration stays open, focus returns to Points.
5. Actual before fix: both popup and configuration close. Evidence:
   artifacts/FR4-modal/dev153-light-en-popover-escape.jpg (RED).

Root: useAppShortcuts registers window capture listener and closes active config
before modal's own Escape handler can choose popup/confirmation/main dialog.
Regression verification must repeat in a freshly restarted test:desktop process.
SSR tests cannot establish window event listener order or native focus behavior.

GREEN verified in fresh Windows desktop processes after the fix:

- Global shortcuts defer config Escape to the config root. The root closes only
  confirmation, then popover, then itself. Removed redundant child listeners after
  checking both dialogs have only this parent caller.
- Help above popup: Tab stays in Help; Escape closes Help only; next Escape closes
  popup only and returns focus to testcase Points.
- Help above save confirmation: Escape closes Help only; next Escape closes
  confirmation only and returns focus to Save. Save-and-clear was not executed.
- Main Tab/Shift+Tab wrap stays inside visible controls; hidden panels excluded.
- The menu opener unmounts. Main close restores the scoreboard problem trigger;
  verified on the latest 960x600 desktop build.

Evidence: final-help-tab-ownership.jpg, final-help-escape-keeps-popup.jpg,
final-popover-escape-keeps-config.jpg, small-help-escape-keeps-confirm.jpg,
small-confirm-escape-keeps-config.jpg, small-main-focus-wrap.jpg,
small-return-focus-scoreboard.jpg. See FR4-modal/manifest.json for build and status.
The earlier final-modal-escape-return-focus.jpg is RED, superseded by small-return.
