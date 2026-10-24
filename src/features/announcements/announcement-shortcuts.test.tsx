import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useAppShortcuts, type UseAppShortcutsOptions } from "../shortcuts/useAppShortcuts.js";

test("announcement modal consumes contest/help/browser shortcuts and leaves Escape to its owner", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  let runs = 0; let reloads = 0; let helps = 0; let articleEscapes = 0;
  const noop = () => {};
  const options: UseAppShortcutsOptions = {
    hostStatus: null, updateHandoffActive: false, interactionLocked: false, canRun: true,
    contestantsList: ["A"], problemsList: ["P"], displayedContestants: ["A"], displayedProblems: ["P"], activeContestant: null, activeProblem: null,
    testsPickerPath: "", contestantsPickerPath: "", isContestDirty: false, hasContestData: true,
    actionMenu: null, activeDetails: null, activeConfigProblem: null, activeLog: null, loadModal: null, helpSection: null, openToolchains: false, showOsdModal: false, pendingScoreDeletion: null, pendingContestAction: null,
    onCloseActionMenu: noop, onCloseActiveDetails: noop, onCloseActiveLog: noop, onCloseLoadModal: noop, onCloseHelpSection: noop,
    onCloseOpenToolchains: noop, onCloseShowOsdModal: noop, onClosePendingScoreDeletion: noop, onClosePendingContestAction: noop,
    onOpenLoadModal: noop, onReloadFolders: () => { ++reloads; }, onOpenToolchains: noop, onToggleOsd: noop,
    onRunJudge: () => { ++runs; }, onExportExcel: noop, onRequestContestAction: noop, onSaveContest: noop, onOpenHelp: () => { ++helps; },
    onSelectAllContestants: noop, onDeselectAllContestants: noop, onToggleActiveContestant: noop, onSelectAllProblems: noop, onDeselectAllProblems: noop, onToggleActiveProblem: noop,
  };
  function Harness({ open, handoff = false }: { open: boolean; handoff?: boolean }) {
    useAppShortcuts({ ...options, announcementModalOpen: open, updateHandoffActive: handoff }); return null;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const press = (key: string) => { const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }); dom.window.dispatchEvent(event); return event; };
  const ownEscape = (event: KeyboardEvent) => { if (event.key === "Escape") ++articleEscapes; };
  try {
    await act(async () => root.render(<Harness open={false} />));
    press("F9"); press("F5"); press("F1"); assert.deepEqual([runs, reloads, helps], [1, 1, 1]);
    await act(async () => root.render(<Harness open />));
    dom.window.addEventListener("keydown", ownEscape, true);
    for (const key of ["F9", "F5", "F1", "Escape"]) assert.equal(press(key).defaultPrevented, true, `${key} must not reach a browser default or contest action`);
    assert.deepEqual([runs, reloads, helps], [1, 1, 1]); assert.equal(articleEscapes, 1);
    await act(async () => root.render(<Harness open={false} handoff />));
    assert.equal(press("F5").defaultPrevented, true, "handoff must also consume the browser reload accelerator");
    assert.equal(reloads, 1);
  } finally {
    dom.window.removeEventListener("keydown", ownEscape, true); await act(async () => root.unmount()); dom.window.close();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
