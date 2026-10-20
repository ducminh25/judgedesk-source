import {
  AlertTriangle,
  BookOpenText,
  Check,
  ClipboardCopy,
  FileCode2,
  FolderTree,
  FolderSync,
  Gavel,
  Info,
  Keyboard,
  PackageOpen,
  Rocket,
  Search,
  Settings2,
  Sparkles,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { HostStatus } from "../../types.js";
import { APP_VERSION } from "../../version.js";
import type { ToolchainState } from "../toolchains/useToolchains.js";

export const HELP_SECTION_IDS = [
  "quick-start",
  "folders-reload",
  "problem-checkers",
  "judging-results",
  "online-judge",
  "shortcuts",
  "toolchains",
  "compile-flags",
  "portable",
  "about",
] as const;

export type HelpSectionId = (typeof HELP_SECTION_IDS)[number];

type HelpBlock =
  | { type: "paragraph"; textKey: string }
  | { type: "note"; textKey: string }
  | { type: "warning"; textKey: string }
  | { type: "heading"; textKey: string }
  | { type: "bullets"; itemKeys: string[] }
  | { type: "steps"; itemKeys: string[] }
  | {
      type: "definitions";
      items: Array<{ termKey: string; descriptionKey: string }>;
    }
  | { type: "code"; labelKey: string; code: string };

interface HelpSectionDefinition {
  id: HelpSectionId;
  localeKey: string;
  icon: LucideIcon;
  blocks: HelpBlock[];
  related?: HelpSectionId[];
}

export interface HelpWorkspacePaths {
  problems: string;
  contestants: string;
}

export interface HelpDiagnosticToolchain {
  id: string;
  language: string;
  status: string;
  source: string;
  version: string;
  executablePath: string;
}

export interface HelpDiagnostics {
  appVersion: string;
  buildNumber: string;
  gitCommit: string;
  builtAt: string;
  edition: string;
  platform: string;
  arch: string;
  tempPath: string;
  appDataPath: string;
  toolchainsPath: string;
  problemsPath: string;
  contestantsPath: string;
  discoveryStatus: string;
  discoveryCompletedAt: string;
  toolchains: HelpDiagnosticToolchain[];
}

interface Props {
  initialSection?: HelpSectionId;
  hostStatus: HostStatus | null;
  workspacePaths: HelpWorkspacePaths;
  loadToolchains?: () => Promise<ToolchainState>;
  onClose: () => void;
  onOpenToolchains?: () => void;
  onOpenChangelog?: () => void;
}

const COMPILE_CONFIG_EXAMPLE = `{
  "compile": {
    "schemaVersion": 1,
    "profile": "themis",
    "flags": {
      "cpp": ["-std=c++14", "-O2", "-pipe"],
      "c": ["-std=c11", "-O2", "-pipe"]
    }
  }
}`;

const HELP_DEFINITIONS: HelpSectionDefinition[] = [
  {
    id: "quick-start",
    localeKey: "quickStart",
    icon: Rocket,
    blocks: [
      { type: "paragraph", textKey: "intro" },
      { type: "heading", textKey: "stepsTitle" },
      {
        type: "steps",
        itemKeys: [
          "steps.loadProblems",
          "steps.loadContestants",
          "steps.configure",
          "steps.judge",
          "steps.save",
        ],
      },
      { type: "note", textKey: "offlineNote" },
    ],
    related: ["folders-reload", "toolchains"],
  },
  {
    id: "folders-reload",
    localeKey: "foldersReload",
    icon: FolderTree,
    blocks: [
      { type: "paragraph", textKey: "intro" },
      { type: "heading", textKey: "layoutTitle" },
      {
        type: "bullets",
        itemKeys: [
          "layout.problems",
          "layout.tests",
          "layout.contestants",
          "layout.submissions",
          "layout.scratch",
        ],
      },
      { type: "heading", textKey: "reloadTitle" },
      { type: "paragraph", textKey: "reloadDescription" },
      { type: "note", textKey: "selectionNote" },
    ],
    related: ["quick-start", "problem-checkers"],
  },
  {
    id: "problem-checkers",
    localeKey: "problemCheckers",
    icon: Settings2,
    blocks: [
      { type: "paragraph", textKey: "intro" },
      {
        type: "bullets",
        itemKeys: [
          "items.io",
          "items.limits",
          "items.points",
          "items.checkers",
          "items.customCheckers",
        ],
      },
      { type: "note", textKey: "configFileNote" },
      { type: "warning", textKey: "resultWarning" },
    ],
    related: ["compile-flags", "judging-results"],
  },
  {
    id: "judging-results",
    localeKey: "judgingResults",
    icon: Gavel,
    blocks: [
      { type: "paragraph", textKey: "intro" },
      {
        type: "bullets",
        itemKeys: [
          "items.selection",
          "items.progress",
          "items.details",
          "items.actions",
          "items.export",
          "items.archive",
        ],
      },
      { type: "heading", textKey: "verdictsTitle" },
      { type: "paragraph", textKey: "verdicts" },
      { type: "warning", textKey: "archivePrivacy" },
    ],
    related: ["problem-checkers", "quick-start", "online-judge"],
  },
  {
    id: "online-judge",
    localeKey: "onlineJudge",
    icon: FolderSync,
    blocks: [
      { type: "paragraph", textKey: "intro" },
      {
        type: "bullets",
        itemKeys: [
          "items.sharing",
          "items.naming",
          "items.ingestion",
          "items.queue",
          "items.logs",
          "items.coordination",
        ],
      },
    ],
    related: ["judging-results", "folders-reload", "shortcuts"],
  },
  {
    id: "shortcuts",
    localeKey: "shortcuts",
    icon: Keyboard,
    blocks: [
      { type: "paragraph", textKey: "intro" },
      { type: "heading", textKey: "functionKeysTitle" },
      {
        type: "definitions",
        items: [
          { termKey: "items.f1.term", descriptionKey: "items.f1.description" },
          { termKey: "items.f2.term", descriptionKey: "items.f2.description" },
          { termKey: "items.f3.term", descriptionKey: "items.f3.description" },
          { termKey: "items.f5.term", descriptionKey: "items.f5.description" },
          { termKey: "items.f6.term", descriptionKey: "items.f6.description" },
          { termKey: "items.f8.term", descriptionKey: "items.f8.description" },
          { termKey: "items.f9.term", descriptionKey: "items.f9.description" },
          { termKey: "items.f12.term", descriptionKey: "items.f12.description" },
        ],
      },
      { type: "heading", textKey: "contestTitle" },
      {
        type: "definitions",
        items: [
          { termKey: "items.ctrlN.term", descriptionKey: "items.ctrlN.description" },
          { termKey: "items.ctrlO.term", descriptionKey: "items.ctrlO.description" },
          { termKey: "items.ctrlS.term", descriptionKey: "items.ctrlS.description" },
          { termKey: "items.ctrlShiftS.term", descriptionKey: "items.ctrlShiftS.description" },
        ],
      },
      { type: "heading", textKey: "selectionTitle" },
      {
        type: "definitions",
        items: [
          { termKey: "items.ctrlA.term", descriptionKey: "items.ctrlA.description" },
          { termKey: "items.ctrlD.term", descriptionKey: "items.ctrlD.description" },
          { termKey: "items.ctrlI.term", descriptionKey: "items.ctrlI.description" },
          { termKey: "items.ctrlShiftA.term", descriptionKey: "items.ctrlShiftA.description" },
          { termKey: "items.ctrlShiftD.term", descriptionKey: "items.ctrlShiftD.description" },
          { termKey: "items.ctrlShiftI.term", descriptionKey: "items.ctrlShiftI.description" },
        ],
      },
      { type: "heading", textKey: "navigationTitle" },
      {
        type: "definitions",
        items: [
          { termKey: "items.esc.term", descriptionKey: "items.esc.description" },
          { termKey: "items.arrows.term", descriptionKey: "items.arrows.description" },
          { termKey: "items.space.term", descriptionKey: "items.space.description" },
          { termKey: "items.enter.term", descriptionKey: "items.enter.description" },
        ],
      },
      { type: "note", textKey: "macNote" },
    ],
    related: ["quick-start", "judging-results"],
  },
  {
    id: "toolchains",
    localeKey: "toolchains",
    icon: Wrench,
    blocks: [
      { type: "paragraph", textKey: "intro" },
      { type: "heading", textKey: "editionsTitle" },
      {
        type: "definitions",
        items: [
          { termKey: "editions.full.term", descriptionKey: "editions.full.description" },
          { termKey: "editions.core.term", descriptionKey: "editions.core.description" },
        ],
      },
      { type: "heading", textKey: "statusesTitle" },
      {
        type: "definitions",
        items: [
          { termKey: "statuses.detected.term", descriptionKey: "statuses.detected.description" },
          { termKey: "statuses.ready.term", descriptionKey: "statuses.ready.description" },
          { termKey: "statuses.checker.term", descriptionKey: "statuses.checker.description" },
          { termKey: "statuses.missing.term", descriptionKey: "statuses.missing.description" },
        ],
      },
      { type: "heading", textKey: "localCompatibilityTitle" },
      {
        type: "definitions",
        items: [
          { termKey: "localCompatibility.strict.term", descriptionKey: "localCompatibility.strict.description" },
          { termKey: "localCompatibility.resourceOnly.term", descriptionKey: "localCompatibility.resourceOnly.description" },
        ],
      },
      { type: "warning", textKey: "localCompatibilityWarning" },
      { type: "heading", textKey: "troubleshootingTitle" },
      {
        type: "steps",
        itemKeys: [
          "troubleshooting.rescan",
          "troubleshooting.path",
          "troubleshooting.version",
          "troubleshooting.managed",
          "troubleshooting.restart",
        ],
      },
      { type: "note", textKey: "integrityNote" },
    ],
    related: ["compile-flags", "about"],
  },
  {
    id: "compile-flags",
    localeKey: "compileFlags",
    icon: FileCode2,
    blocks: [
      { type: "paragraph", textKey: "intro" },
      { type: "note", textKey: "checkerNote" },
      { type: "heading", textKey: "presetsTitle" },
      {
        type: "definitions",
        items: [
          { termKey: "presets.themis.term", descriptionKey: "presets.themis.description" },
          { termKey: "presets.modern.term", descriptionKey: "presets.modern.description" },
          { termKey: "presets.icpc.term", descriptionKey: "presets.icpc.description" },
          { termKey: "presets.custom.term", descriptionKey: "presets.custom.description" },
        ],
      },
      { type: "code", labelKey: "configExample", code: COMPILE_CONFIG_EXAMPLE },
      { type: "note", textKey: "platformNote" },
      { type: "warning", textKey: "invalidationWarning" },
      { type: "paragraph", textKey: "restore" },
    ],
    related: ["problem-checkers", "toolchains"],
  },
  {
    id: "portable",
    localeKey: "portable",
    icon: PackageOpen,
    blocks: [
      { type: "warning", textKey: "notShipped" },
      { type: "paragraph", textKey: "compatibility" },
      {
        type: "bullets",
        itemKeys: [
          "items.installer",
          "items.contestArchive",
          "items.futureWindows",
          "items.futureMac",
        ],
      },
      { type: "note", textKey: "terminology" },
    ],
    related: ["quick-start", "about"],
  },
  {
    id: "about",
    localeKey: "about",
    icon: Info,
    blocks: [
      { type: "paragraph", textKey: "intro" },
      { type: "note", textKey: "themisCredit" },
      { type: "note", textKey: "scratchRunCredit" },
      { type: "paragraph", textKey: "disclaimer" },
    ],
    related: ["toolchains", "portable"],
  },
];

function localePath(section: HelpSectionDefinition, suffix: string): string {
  return `helpCenter.sections.${section.localeKey}.${suffix}`;
}

function translatedBlockText(
  section: HelpSectionDefinition,
  block: HelpBlock,
  t: TFunction,
): string[] {
  if (block.type === "paragraph" || block.type === "note" || block.type === "warning" || block.type === "heading") {
    return [t(localePath(section, block.textKey))];
  }
  if (block.type === "bullets" || block.type === "steps") {
    return block.itemKeys.map((key) => t(localePath(section, key)));
  }
  if (block.type === "definitions") {
    return block.items.flatMap((item) => [
      t(localePath(section, item.termKey)),
      t(localePath(section, item.descriptionKey)),
    ]);
  }
  return [t(localePath(section, block.labelKey)), block.code];
}

export function filterHelpSections(
  sections: HelpSectionDefinition[],
  query: string,
  t: TFunction,
): HelpSectionDefinition[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return sections;
  return sections.filter((section) => {
    const searchable = [
      t(localePath(section, "title")),
      t(localePath(section, "summary")),
      ...section.blocks.flatMap((block) => translatedBlockText(section, block, t)),
    ].join("\n").toLocaleLowerCase();
    return searchable.includes(normalized);
  });
}

export function isHelpShortcut(event: Pick<KeyboardEvent, "key">): boolean {
  return event.key === "F1";
}

export function defaultAppDataPath(platform: string): string {
  if (platform === "win32") return "%LOCALAPPDATA%\\ThemisV2";
  if (platform === "darwin") return "~/Library/Application Support/ThemisV2";
  if (platform === "linux") return "~/.local/share/ThemisV2";
  return "~/.themisv2-dev";
}

export function buildHelpDiagnosticsText(
  diagnostics: HelpDiagnostics,
): string {
  const lines = [
    "JudgeDesk diagnostics",
    `App version: ${diagnostics.appVersion}`,
    `Build number: ${diagnostics.buildNumber}`,
    `Git commit: ${diagnostics.gitCommit}`,
    `Built at: ${diagnostics.builtAt}`,
    `Edition: ${diagnostics.edition}`,
    `Platform: ${diagnostics.platform}`,
    `Architecture: ${diagnostics.arch}`,
    `App data (default): ${diagnostics.appDataPath}`,
    `Managed toolchains (default): ${diagnostics.toolchainsPath}`,
    `Temporary workspace: ${diagnostics.tempPath}`,
    `Problems path: ${diagnostics.problemsPath}`,
    `Contestants path: ${diagnostics.contestantsPath}`,
    `Toolchain discovery: ${diagnostics.discoveryStatus}`,
    `Toolchain discovery completed: ${diagnostics.discoveryCompletedAt}`,
  ];
  for (const toolchain of diagnostics.toolchains) {
    lines.push(
      `Toolchain ${toolchain.language} (${toolchain.id}): status=${toolchain.status}; source=${toolchain.source}; version=${toolchain.version}; path=${toolchain.executablePath}`,
    );
  }
  return lines.join("\n");
}

async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (typeof document === "undefined") throw new Error("Clipboard unavailable");
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();
  if (!copied) throw new Error("Clipboard unavailable");
}

function diagnosticToolchains(
  state: ToolchainState | null,
  t: TFunction,
): HelpDiagnosticToolchain[] {
  if (!state) return [];
  return state.profiles
    .filter((profile) => profile.active.source !== "none" || profile.status !== "not_available")
    .map((profile) => ({
      id: profile.id,
      language: t(profile.displayNameKey),
      status: profile.status,
      source: profile.active.source,
      version: profile.active.version || "unknown",
      executablePath: profile.active.executablePath || "not selected",
    }));
}

function sectionById(id: HelpSectionId): HelpSectionDefinition {
  return HELP_DEFINITIONS.find((section) => section.id === id) ?? HELP_DEFINITIONS[0];
}

export default function HelpCenter({
  initialSection = "quick-start",
  hostStatus,
  workspacePaths,
  loadToolchains,
  onClose,
  onOpenToolchains,
  onOpenChangelog,
}: Props) {
  const { t } = useTranslation();
  const [activeSectionId, setActiveSectionId] = useState<HelpSectionId>(initialSection);
  const [query, setQuery] = useState("");
  const [toolchainState, setToolchainState] = useState<ToolchainState | null>(null);
  const [environmentError, setEnvironmentError] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    searchRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const openDialogs = document.querySelectorAll('[aria-modal="true"]');
      if (openDialogs.length > 0 && openDialogs[openDialogs.length - 1] !== dialogRef.current) {
        return;
      }
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("keydown", closeOnEscape, true);
      previouslyFocusedRef.current?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    if (!loadToolchains) return;
    let active = true;
    void loadToolchains()
      .then((state) => {
        if (active) setToolchainState(state);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setEnvironmentError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [loadToolchains]);

  const filteredSections = useMemo(
    () => filterHelpSections(HELP_DEFINITIONS, query, t),
    [query, t],
  );
  const visibleSection = filteredSections.some((section) => section.id === activeSectionId)
    ? sectionById(activeSectionId)
    : filteredSections[0] ?? null;

  const platform = toolchainState?.platform || hostStatus?.platform || "unknown";
  const appDataPath = defaultAppDataPath(platform);
  const diagnostics = useMemo<HelpDiagnostics>(() => ({
    appVersion: hostStatus?.build?.appVersion || APP_VERSION,
    buildNumber: hostStatus?.build?.buildNumber || "unknown",
    gitCommit: hostStatus?.build?.gitCommit || "unknown",
    builtAt: hostStatus?.build?.builtAt || "unknown",
    edition: toolchainState?.distribution || "unknown",
    platform,
    arch: toolchainState?.arch || "unknown",
    tempPath: hostStatus?.tempDir || t("helpCenter.aboutValues.notAvailable"),
    appDataPath,
    toolchainsPath: `${appDataPath}${platform === "win32" ? "\\toolchains" : "/toolchains"}`,
    problemsPath: workspacePaths.problems || t("helpCenter.aboutValues.notLoaded"),
    contestantsPath: workspacePaths.contestants || t("helpCenter.aboutValues.notLoaded"),
    discoveryStatus: toolchainState?.discovery.status || "unknown",
    discoveryCompletedAt: toolchainState?.discovery.completedAt || "unknown",
    toolchains: diagnosticToolchains(toolchainState, t),
  }), [appDataPath, hostStatus, platform, t, toolchainState, workspacePaths]);

  const selectSection = (id: HelpSectionId) => {
    setActiveSectionId(id);
    setQuery("");
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-2 sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-center-title"
        className="flex h-[min(92vh,880px)] w-full max-w-7xl flex-col overflow-hidden rounded-lg border border-surface-border bg-surface shadow-lg"
      >
        <header className="flex flex-none items-center gap-3 border-b border-surface-border bg-surface-elevated px-4 py-3 sm:px-5">
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-md bg-indigo-600 text-white">
            <BookOpenText className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="help-center-title" className="text-sm font-bold text-text-primary sm:text-base">
              {t("helpCenter.title")}
            </h2>
            <p className="truncate text-[11px] text-text-muted sm:text-xs">
              {t("helpCenter.subtitle")}
            </p>
          </div>
          <div className="hidden rounded border border-surface-border bg-input-bg px-2 py-1 font-mono text-[10px] text-text-muted sm:block">
            F1 · Esc
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-2 text-text-muted transition hover:bg-surface-hover hover:text-text-primary"
            aria-label={t("common.close")}
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[18rem_minmax(0,1fr)] md:grid-rows-1">
          <aside className="flex max-h-52 min-h-0 flex-col border-b border-surface-border bg-surface-elevated md:max-h-none md:border-b-0 md:border-r">
            <div className="flex-none p-3">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("helpCenter.searchPlaceholder")}
                  aria-label={t("helpCenter.searchLabel")}
                  className="h-10 w-full rounded-md border border-surface-border bg-input-bg pl-9 pr-3 text-xs text-text-primary outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                />
              </label>
              <div className="mt-2 px-1 text-[10px] text-text-muted" aria-live="polite">
                {t("helpCenter.searchCount", { count: filteredSections.length })}
              </div>
            </div>
            <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label={t("helpCenter.contentsLabel")}>
              {filteredSections.map((section) => {
                const Icon = section.icon;
                const selected = visibleSection?.id === section.id;
                return (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => selectSection(section.id)}
                    aria-current={selected ? "page" : undefined}
                    aria-controls={`help-section-${section.id}`}
                    className={`mb-1 flex w-full items-start gap-2.5 rounded-md px-3 py-2.5 text-left transition ${
                      selected
                        ? "bg-indigo-600 text-white"
                        : "text-text-primary hover:bg-surface-hover"
                    }`}
                  >
                    <Icon className={`mt-0.5 h-4 w-4 flex-none ${selected ? "text-white" : "text-indigo-500"}`} />
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold">
                        {t(localePath(section, "title"))}
                      </span>
                      <span className={`mt-0.5 block text-[10px] leading-4 ${selected ? "text-indigo-100" : "text-text-muted"}`}>
                        {t(localePath(section, "summary"))}
                      </span>
                    </span>
                  </button>
                );
              })}
              {filteredSections.length === 0 && (
                <div className="rounded-md border border-dashed border-surface-border px-3 py-5 text-center text-xs text-text-muted">
                  {t("helpCenter.noResults")}
                </div>
              )}
            </nav>
          </aside>

          <main className="min-h-0 overflow-y-auto bg-surface px-4 py-5 sm:px-7 sm:py-6">
            {visibleSection ? (
              <HelpArticle
                section={visibleSection}
                diagnostics={diagnostics}
                environmentError={environmentError}
                copyState={copyState}
                onCopy={async () => {
                  try {
                    await copyText(buildHelpDiagnosticsText(diagnostics));
                    setCopyState("copied");
                  } catch {
                    setCopyState("failed");
                  }
                }}
                onOpenToolchains={onOpenToolchains}
                onOpenChangelog={onOpenChangelog}
                onSelectSection={selectSection}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-text-muted">
                {t("helpCenter.noResults")}
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function HelpArticle({
  section,
  diagnostics,
  environmentError,
  copyState,
  onCopy,
  onOpenToolchains,
  onOpenChangelog,
  onSelectSection,
}: {
  section: HelpSectionDefinition;
  diagnostics: HelpDiagnostics;
  environmentError: string;
  copyState: "idle" | "copied" | "failed";
  onCopy: () => void;
  onOpenToolchains?: () => void;
  onOpenChangelog?: () => void;
  onSelectSection: (id: HelpSectionId) => void;
}) {
  const { t } = useTranslation();
  const Icon = section.icon;
  return (
    <article id={`help-section-${section.id}`} data-help-anchor={section.id} className="mx-auto max-w-4xl">
      <div className="mb-6 flex items-start gap-3 border-b border-surface-border pb-5">
        <div className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-300">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <h3 className="text-lg font-bold text-text-primary">
            {t(localePath(section, "title"))}
          </h3>
          <p className="mt-1 text-xs leading-5 text-text-muted">
            {t(localePath(section, "summary"))}
          </p>
        </div>
      </div>

      <div className="space-y-4 text-sm leading-6 text-text-primary">
        {section.blocks.map((block, index) => (
          <Fragment key={`${section.id}-${index}`}>
            <HelpBlockView section={section} block={block} />
          </Fragment>
        ))}
      </div>

      {section.id === "toolchains" && onOpenToolchains && (
        <button
          type="button"
          onClick={onOpenToolchains}
          className="mt-6 inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-xs font-bold text-white transition hover:bg-indigo-500"
        >
          <Wrench className="h-4 w-4" />
          {t("helpCenter.openToolchains")}
        </button>
      )}

      {section.id === "about" && (
        <AboutDiagnostics
          diagnostics={diagnostics}
          environmentError={environmentError}
          copyState={copyState}
          onCopy={onCopy}
          onOpenChangelog={onOpenChangelog}
        />
      )}

      {section.related && section.related.length > 0 && (
        <div className="mt-8 border-t border-surface-border pt-5">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-text-muted">
            {t("helpCenter.related")}
          </div>
          <div className="flex flex-wrap gap-2">
            {section.related.map((id) => {
              const related = sectionById(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onSelectSection(id)}
                  className="rounded border border-surface-border bg-surface-elevated px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-surface-hover transition-colors"
                >
                  {t(localePath(related, "title"))}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </article>
  );
}

function HelpBlockView({ section, block }: { section: HelpSectionDefinition; block: HelpBlock }) {
  const { t } = useTranslation();
  if (block.type === "paragraph") {
    return <p>{t(localePath(section, block.textKey))}</p>;
  }
  if (block.type === "heading") {
    return <h4 className="pt-2 text-sm font-bold text-text-primary">{t(localePath(section, block.textKey))}</h4>;
  }
  if (block.type === "note" || block.type === "warning") {
    const warning = block.type === "warning";
    return (
      <div className={`flex items-start gap-2 rounded-md border px-3.5 py-3 text-xs leading-5 ${
        warning
          ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
          : "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-200"
      }`}>
        {warning ? <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" /> : <Info className="mt-0.5 h-4 w-4 flex-none" />}
        <span>{t(localePath(section, block.textKey))}</span>
      </div>
    );
  }
  if (block.type === "bullets" || block.type === "steps") {
    const List = block.type === "steps" ? "ol" : "ul";
    return (
      <List className={`space-y-2 pl-5 ${block.type === "steps" ? "list-decimal" : "list-disc"}`}>
        {block.itemKeys.map((key) => <li key={key}>{t(localePath(section, key))}</li>)}
      </List>
    );
  }
  if (block.type === "definitions") {
    return (
      <dl className="grid gap-3 sm:grid-cols-2">
        {block.items.map((item) => (
          <div key={item.termKey} className="rounded-md border border-surface-border bg-surface-elevated p-3">
            <dt className="text-xs font-bold text-text-primary">{t(localePath(section, item.termKey))}</dt>
            <dd className="mt-1 text-xs leading-5 text-text-muted">{t(localePath(section, item.descriptionKey))}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <div>
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-text-muted">
        {t(localePath(section, block.labelKey))}
      </div>
      <pre className="overflow-x-auto rounded-md border border-surface-border bg-slate-950 p-4 text-xs leading-5 text-slate-100">
        <code>{block.code}</code>
      </pre>
    </div>
  );
}

function AboutDiagnostics({
  diagnostics,
  environmentError,
  copyState,
  onCopy,
  onOpenChangelog,
}: {
  diagnostics: HelpDiagnostics;
  environmentError: string;
  copyState: "idle" | "copied" | "failed";
  onCopy: () => void;
  onOpenChangelog?: () => void;
}) {
  const { t } = useTranslation();
  const rows = [
    [t("helpCenter.aboutLabels.version"), diagnostics.appVersion],
    [t("helpCenter.aboutLabels.build"), diagnostics.buildNumber],
    [t("helpCenter.aboutLabels.commit"), diagnostics.gitCommit === "unknown" ? "unknown" : diagnostics.gitCommit.slice(0, 12)],
    [t("helpCenter.aboutLabels.edition"), t(`helpCenter.editions.${diagnostics.edition}`, { defaultValue: diagnostics.edition })],
    [t("helpCenter.aboutLabels.platform"), `${diagnostics.platform} / ${diagnostics.arch}`],
    [t("helpCenter.aboutLabels.appData"), diagnostics.appDataPath],
    [t("helpCenter.aboutLabels.toolchains"), diagnostics.toolchainsPath],
    [t("helpCenter.aboutLabels.temporary"), diagnostics.tempPath],
    [t("helpCenter.aboutLabels.problems"), diagnostics.problemsPath],
    [t("helpCenter.aboutLabels.contestants"), diagnostics.contestantsPath],
  ];
  return (
    <section className="mt-6 rounded-lg border border-surface-border bg-surface-elevated p-4" aria-labelledby="help-about-environment">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 id="help-about-environment" className="text-sm font-bold text-text-primary">
            {t("helpCenter.environmentTitle")}
          </h4>
          <p className="mt-1 text-[11px] text-text-muted">{t("helpCenter.environmentSubtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          {onOpenChangelog && (
            <button
              type="button"
              onClick={onOpenChangelog}
              className="inline-flex items-center gap-1.5 rounded-md border border-surface-border bg-input-bg px-3 py-2 text-xs font-semibold text-text-primary transition hover:bg-surface-hover"
            >
              <Sparkles className="h-4 w-4 text-indigo-500 dark:text-indigo-400" />
              {t("changelog.viewChangelog", "Nhật ký thay đổi")}
            </button>
          )}
          <button
            type="button"
            onClick={onCopy}
            className="inline-flex items-center gap-2 rounded-md border border-surface-border bg-input-bg px-3 py-2 text-xs font-semibold text-text-primary transition hover:bg-surface-hover"
          >
            {copyState === "copied" ? <Check className="h-4 w-4 text-emerald-500" /> : <ClipboardCopy className="h-4 w-4 text-indigo-500" />}
            {t(`helpCenter.copy.${copyState}`)}
          </button>
        </div>
      </div>
      <dl className="mt-4 grid gap-x-5 gap-y-3 text-xs sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="font-semibold text-text-muted">{label}</dt>
            <dd className="mt-0.5 break-all font-mono text-[11px] text-text-primary">{value}</dd>
          </div>
        ))}
      </dl>
      {diagnostics.toolchains.length > 0 && (
        <div className="mt-4 border-t border-surface-border pt-3">
          <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
            {t("helpCenter.activeToolchains")}
          </div>
          <div className="mt-2 space-y-2">
            {diagnostics.toolchains.map((toolchain) => (
              <div key={toolchain.id} className="rounded border border-surface-border bg-input-bg px-3 py-2 text-[11px]">
                <div className="font-semibold text-text-primary">
                  {toolchain.language} · {toolchain.status} · {toolchain.source}
                </div>
                <div className="mt-0.5 break-all font-mono text-text-muted">
                  {toolchain.version} · {toolchain.executablePath}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {environmentError && (
        <div className="mt-3 text-[11px] text-amber-600 dark:text-amber-300">
          {t("helpCenter.environmentUnavailable")}: {environmentError}
        </div>
      )}
      <p className="mt-4 text-[10px] leading-4 text-text-muted">
        {t("helpCenter.diagnosticsPrivacy")}
      </p>
    </section>
  );
}

export type { HelpSectionDefinition };
