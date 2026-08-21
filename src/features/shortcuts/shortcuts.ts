export type ShortcutAction =
  | "escape"
  | "help"
  | "loadProblems"
  | "loadContestants"
  | "reload"
  | "toolchains"
  | "judge"
  | "exportExcel"
  | "newContest"
  | "openContest"
  | "saveContest"
  | "saveContestAs"
  | "selectAllContestants"
  | "deselectAllContestants"
  | "toggleActiveContestant"
  | "selectAllProblems"
  | "deselectAllProblems"
  | "toggleActiveProblem"
  | "toggleOsd";

export function isMacOS(platform?: string): boolean {
  if (platform !== undefined) {
    const p = platform.toLowerCase();
    return p === "darwin" || p.includes("mac");
  }
  if (typeof navigator !== "undefined" && (navigator.platform || navigator.userAgent)) {
    const p = (navigator.platform || "").toUpperCase();
    const ua = (navigator.userAgent || "").toUpperCase();
    return p.includes("MAC") || ua.includes("MAC") || ua.includes("IPHONE") || ua.includes("IPAD");
  }
  if (typeof process !== "undefined" && process.platform) {
    return process.platform === "darwin";
  }
  return false;
}

export function isTextInputTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  if (tagName === "input") {
    const type = (target as HTMLInputElement).type.toLowerCase();
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(type);
  }
  return tagName === "textarea" || target.isContentEditable;
}

export interface ShortcutEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | null;
}

export function matchShortcut(event: ShortcutEventLike, isMac: boolean): ShortcutAction | null {
  const key = event.key;
  const inTextInput = isTextInputTarget(event.target ?? null);

  // Esc key closes dialogs/modals regardless of whether focus is in an input
  if (key === "Escape") {
    return "escape";
  }

  // Function keys work globally (unless modifier keys like Alt/Ctrl are held)
  if (!event.altKey) {
    if (key === "F1") return "help";
    if (key === "F2") return "loadProblems";
    if (key === "F3") return "loadContestants";
    if (key === "F5") return "reload";
    if (key === "F6") return "toolchains";
    if (key === "F8") return "toggleOsd";
    if (key === "F9") return "judge";
    if (key === "F12") return "exportExcel";
  }

  // Primary modifier is Cmd on macOS and Ctrl on Windows/Linux
  const primaryModifier = isMac ? !!event.metaKey : !!event.ctrlKey;
  const shift = !!event.shiftKey;
  const alt = !!event.altKey;

  // We do not intercept primary modifier letter shortcuts when user is actively editing text in an input
  if (inTextInput) {
    return null;
  }

  if (primaryModifier && !alt) {
    const lowerKey = key.toLowerCase();

    if (shift) {
      if (lowerKey === "s") return "saveContestAs";
      if (lowerKey === "a") return "selectAllProblems";
      if (lowerKey === "d") return "deselectAllProblems";
      if (lowerKey === "i") return "toggleActiveProblem";
    } else {
      if (lowerKey === "n") return "newContest";
      if (lowerKey === "o") return "openContest";
      if (lowerKey === "s") return "saveContest";
      if (lowerKey === "a") return "selectAllContestants";
      if (lowerKey === "d") return "deselectAllContestants";
      if (lowerKey === "i") return "toggleActiveContestant";
    }
  }

  return null;
}

export function formatShortcut(action: ShortcutAction, isMac: boolean): string {
  const mod = isMac ? "⌘" : "Ctrl+";
  const shiftMod = isMac ? "⇧⌘" : "Ctrl+Shift+";

  switch (action) {
    case "escape": return "Esc";
    case "help": return "F1";
    case "loadProblems": return "F2";
    case "loadContestants": return "F3";
    case "reload": return "F5";
    case "toolchains": return "F6";
    case "toggleOsd": return "F8";
    case "judge": return "F9";
    case "exportExcel": return "F12";
    case "newContest": return `${mod}N`;
    case "openContest": return `${mod}O`;
    case "saveContest": return `${mod}S`;
    case "saveContestAs": return `${shiftMod}S`;
    case "selectAllContestants": return `${mod}A`;
    case "deselectAllContestants": return `${mod}D`;
    case "toggleActiveContestant": return `${mod}I`;
    case "selectAllProblems": return `${shiftMod}A`;
    case "deselectAllProblems": return `${shiftMod}D`;
    case "toggleActiveProblem": return `${shiftMod}I`;
  }
}
