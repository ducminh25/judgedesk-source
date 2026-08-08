import { AlertCircle, Code2, ShieldCheck } from "lucide-react";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  CompileFlags,
  CompileLanguage,
  CompileProfile,
  ProblemCompileConfig,
  ProblemConfig,
} from "../../types.js";
import {
  createCompileConfig,
  createCustomCompileConfig,
  CompileConfigValidationError,
  normalizeCompileConfig,
  parseAndValidateCustomCompileFlags,
  type PresetCompileProfile,
} from "../../../shared/compile-config.js";

const COMPILE_PROFILE_OPTIONS: Array<{
  id: CompileProfile;
  translationKey: string;
}> = [
  { id: "themis", translationKey: "themis" },
  { id: "modern_ioi_icpc_2025", translationKey: "modern" },
  { id: "icpc_world_finals", translationKey: "icpc" },
  { id: "custom", translationKey: "custom" },
];

export interface CustomCompileDraftResult {
  config: ProblemCompileConfig | null;
  errors: Partial<Record<CompileLanguage, string>>;
  errorDetails: Partial<Record<CompileLanguage, CompileConfigValidationError>>;
}

interface Props {
  value?: ProblemCompileConfig;
  onChange: (value: ProblemCompileConfig) => void;
  onValidityChange?: (valid: boolean) => void;
}

export function formatCompileFlags(flags: readonly string[]): string {
  return flags
    .map((flag) => {
      if (/^[^\s"'\\]+$/u.test(flag)) return flag;
      return `"${flag.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
    })
    .join(" ");
}

export function parseCustomCompileDraft(
  cppText: string,
  cText: string,
): CustomCompileDraftResult {
  const errors: Partial<Record<CompileLanguage, string>> = {};
  const errorDetails: Partial<Record<CompileLanguage, CompileConfigValidationError>> = {};
  let cpp: string[] = [];
  let c: string[] = [];

  try {
    cpp = parseAndValidateCustomCompileFlags(cppText);
  } catch (error) {
    errors.cpp = error instanceof Error ? error.message : String(error);
    if (error instanceof CompileConfigValidationError) errorDetails.cpp = error;
  }
  try {
    c = parseAndValidateCustomCompileFlags(cText);
  } catch (error) {
    errors.c = error instanceof Error ? error.message : String(error);
    if (error instanceof CompileConfigValidationError) errorDetails.c = error;
  }

  if (errors.cpp || errors.c) return { config: null, errors, errorDetails };
  return { config: createCustomCompileConfig({ cpp, c }), errors, errorDetails };
}

export function localizedCompileValidationMessage(
  error: CompileConfigValidationError | undefined,
  fallback: string,
  t: TFunction,
): string {
  if (!error) return fallback;
  return t(`problemConfig.compile.errors.${error.reason}`, {
    flag: error.flagNumber,
    token: error.token,
    limit: error.limit,
    defaultValue: fallback,
  });
}

export function compileConfigForProfile(
  current: ProblemCompileConfig | undefined,
  profile: CompileProfile,
): ProblemCompileConfig {
  const normalized = normalizeCompileConfig(current);
  return profile === "custom"
    ? createCustomCompileConfig(normalized.flags)
    : createCompileConfig(profile as PresetCompileProfile);
}

export function withProblemCompileConfig(
  config: ProblemConfig,
  compile: ProblemCompileConfig,
): ProblemConfig {
  return { ...config, compile };
}

export function CompileProblemSettings({
  value,
  onChange,
  onValidityChange,
}: Props) {
  const { t } = useTranslation();
  const normalized = useMemo(() => normalizeCompileConfig(value), [value]);
  const valueSignature = JSON.stringify(normalized);
  const [cppText, setCppText] = useState(() => formatCompileFlags(normalized.flags.cpp));
  const [cText, setCText] = useState(() => formatCompileFlags(normalized.flags.c));
  const [errors, setErrors] = useState<Partial<Record<CompileLanguage, string>>>({});
  const [errorDetails, setErrorDetails] = useState<
    Partial<Record<CompileLanguage, CompileConfigValidationError>>
  >({});
  const lastEmittedSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastEmittedSignatureRef.current === valueSignature) {
      lastEmittedSignatureRef.current = null;
      return;
    }
    setCppText(formatCompileFlags(normalized.flags.cpp));
    setCText(formatCompileFlags(normalized.flags.c));
    setErrors({});
    setErrorDetails({});
    onValidityChange?.(true);
  }, [normalized.flags.c, normalized.flags.cpp, onValidityChange, valueSignature]);

  const emit = (next: ProblemCompileConfig) => {
    lastEmittedSignatureRef.current = JSON.stringify(next);
    onChange(next);
  };

  const selectProfile = (profile: CompileProfile) => {
    const next = compileConfigForProfile(normalized, profile);
    setCppText(formatCompileFlags(next.flags.cpp));
    setCText(formatCompileFlags(next.flags.c));
    setErrors({});
    setErrorDetails({});
    onValidityChange?.(true);
    emit(next);
  };

  const updateCustomDraft = (language: CompileLanguage, text: string) => {
    const nextCppText = language === "cpp" ? text : cppText;
    const nextCText = language === "c" ? text : cText;
    if (language === "cpp") setCppText(text);
    else setCText(text);

    const parsed = parseCustomCompileDraft(nextCppText, nextCText);
    setErrors(parsed.errors);
    setErrorDetails(parsed.errorDetails);
    const valid = parsed.config !== null;
    onValidityChange?.(valid);
    if (parsed.config) emit(parsed.config);
  };

  const currentFlags = normalized.flags;
  const isCustom = normalized.profile === "custom";

  return (
    <section
      className="rounded-lg border border-surface-border bg-surface-elevated p-4"
      aria-labelledby="problem-compile-settings-title"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-md bg-indigo-50 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-300">
          <Code2 className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h4 id="problem-compile-settings-title" className="text-xs font-bold uppercase tracking-wider text-text-primary">
            {t("problemConfig.compile.title")}
          </h4>
          <p className="mt-1 text-[11px] leading-5 text-text-muted">
            {t("problemConfig.compile.description")}
          </p>
        </div>
      </div>

      <label className="mt-4 block">
        <span className="mb-1.5 block text-[11px] font-semibold text-text-primary">
          {t("problemConfig.compile.profile")}
        </span>
        <select
          value={normalized.profile}
          onChange={(event) => selectProfile(event.target.value as CompileProfile)}
          className="h-9 w-full rounded border border-surface-border-strong bg-input-bg px-2.5 text-xs text-text-primary outline-none transition focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
        >
          {COMPILE_PROFILE_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {t(`problemConfig.compile.profiles.${option.translationKey}`)}
            </option>
          ))}
        </select>
      </label>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <CompileLanguageField
          language="cpp"
          label={t("problemConfig.compile.cppFlags")}
          custom={isCustom}
          text={cppText}
          flags={currentFlags.cpp}
          error={errors.cpp}
          errorDetail={errorDetails.cpp}
          onChange={(text) => updateCustomDraft("cpp", text)}
        />
        <CompileLanguageField
          language="c"
          label={t("problemConfig.compile.cFlags")}
          custom={isCustom}
          text={cText}
          flags={currentFlags.c}
          error={errors.c}
          errorDetail={errorDetails.c}
          onChange={(text) => updateCustomDraft("c", text)}
        />
      </div>

      <div className="mt-3 flex items-start gap-2 rounded border border-sky-200 bg-sky-50 px-3 py-2 text-[10px] leading-4 text-sky-900 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-200">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 flex-none" />
        <span>{t("problemConfig.compile.safetyNote")}</span>
      </div>
    </section>
  );
}

function CompileLanguageField({
  language,
  label,
  custom,
  text,
  flags,
  error,
  errorDetail,
  onChange,
}: {
  language: CompileLanguage;
  label: string;
  custom: boolean;
  text: string;
  flags: CompileFlags[CompileLanguage];
  error?: string;
  errorDetail?: CompileConfigValidationError;
  onChange: (text: string) => void;
}) {
  const { t } = useTranslation();
  const errorId = `problem-compile-${language}-error`;
  return (
    <div className="rounded border border-surface-border bg-input-bg p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label htmlFor={`problem-compile-${language}`} className="text-[11px] font-bold text-text-primary">
          {label}
        </label>
        <span className="font-mono text-[9px] uppercase tracking-wider text-text-muted">
          {custom ? t("problemConfig.compile.customArgv") : t("problemConfig.compile.presetSnapshot")}
        </span>
      </div>
      {custom ? (
        <textarea
          id={`problem-compile-${language}`}
          rows={2}
          value={text}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          className={`w-full resize-y rounded border bg-surface px-2.5 py-2 font-mono text-[11px] leading-5 text-text-primary outline-none transition ${
            error
              ? "border-rose-400 focus:border-rose-500"
              : "border-surface-border-strong focus:border-indigo-500"
          }`}
        />
      ) : (
        <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded border border-surface-border bg-surface px-2.5 py-2">
          {flags.map((flag, index) => (
            <code key={`${flag}-${index}`} className="rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] text-text-primary">
              {flag}
            </code>
          ))}
        </div>
      )}
      {error ? (
        <p id={errorId} role="alert" className="mt-1.5 flex items-start gap-1 text-[10px] leading-4 text-rose-600 dark:text-rose-300">
          <AlertCircle className="mt-0.5 h-3 w-3 flex-none" />
          <span>{t("problemConfig.compile.invalidFlags", {
            message: localizedCompileValidationMessage(errorDetail, error, t),
          })}</span>
        </p>
      ) : custom ? (
        <p className="mt-1.5 break-all font-mono text-[9px] leading-4 text-text-muted">
          {t("problemConfig.compile.argvPreview")}: {JSON.stringify(flags)}
        </p>
      ) : null}
    </div>
  );
}
