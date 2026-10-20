import { AlertTriangle, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

interface StartupFailureProps {
  onRetry: () => void;
  retrying: boolean;
}

export default function StartupFailure({ onRetry, retrying }: StartupFailureProps) {
  const { t } = useTranslation();

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface p-6 text-text-primary">
      <section
        className="w-full max-w-lg rounded border border-surface-border bg-surface-elevated p-6"
        role="alert"
        aria-labelledby="startup-failure-title"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle
            className="mt-0.5 h-5 w-5 flex-none text-rose-700 dark:text-rose-300"
            aria-hidden="true"
          />
          <div>
            <h1 id="startup-failure-title" className="text-base font-semibold">
              {t("startupFailure.title")}
            </h1>
            <p className="mt-2 text-sm leading-6 text-text-muted">
              {t("startupFailure.reason")}
            </p>
            <p className="mt-1 text-sm leading-6 text-text-muted">
              {t("startupFailure.action")}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="mt-5 inline-flex min-h-9 items-center gap-2 rounded border border-surface-border-strong bg-surface px-3 py-2 text-sm font-semibold hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-700 disabled:cursor-wait disabled:opacity-60 dark:focus-visible:outline-indigo-300"
          disabled={retrying}
          onClick={onRetry}
          autoFocus
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          {retrying ? t("startupFailure.retrying") : t("startupFailure.retry")}
        </button>
      </section>
    </main>
  );
}
