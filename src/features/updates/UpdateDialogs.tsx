import { Coffee, Download, HardDrive, PackageCheck, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  formatUpdateBytes,
  type AppUpdateCandidate,
  type UpdateEdition,
} from "./catalog.js";
import type { AppUpdateCandidates } from "./useAppUpdater.js";

interface EditionChooserProps {
  version: string;
  currentEdition: UpdateEdition;
  candidates: AppUpdateCandidates;
  onCancel(): void;
  onChoose(edition: UpdateEdition): void;
}

export function UpdateEditionDialog({
  version,
  currentEdition,
  candidates,
  onCancel,
  onChoose,
}: EditionChooserProps) {
  const { t, i18n } = useTranslation();
  return (
    <ModalFrame title={t("updates.chooseTitle", { version })} onClose={onCancel}>
      <p className="text-sm leading-6 text-text-muted">
        {t("updates.chooseMessage")}
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {(["core", "full"] as const).map((edition) => {
          const candidate = candidates[edition];
          const isCurrent = edition === currentEdition;
          return (
            <button
              key={edition}
              type="button"
              onClick={() => onChoose(edition)}
              className="rounded-lg border border-surface-border bg-surface-elevated p-4 text-left transition-colors hover:border-indigo-400 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-base font-bold text-text-primary">
                  {t(`updates.editions.${edition}.name`)}
                </span>
                <div className="flex items-center gap-1.5">
                  {isCurrent && (
                    <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                      {t("updates.currentEdition")}
                    </span>
                  )}
                  {edition === "core" && (
                    <span className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-bold uppercase text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      {t("updates.recommended")}
                    </span>
                  )}
                </div>
              </div>
              <p className="mt-2 min-h-12 text-xs leading-5 text-text-muted">
                {t(`updates.editions.${edition}.description`)}
              </p>
              <SizeRows candidate={candidate} locale={i18n.language} />
            </button>
          );
        })}
      </div>
      <p className="mt-4 rounded border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
        {t("updates.downloadCleanupHint")}
      </p>
      <div className="mt-5 flex justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-surface-border bg-input-bg px-4 py-2 text-xs font-semibold text-text-primary hover:bg-surface-hover"
        >
          {t("common.cancel")}
        </button>
      </div>
    </ModalFrame>
  );
}

export function UpdateEditionChangeDialog({
  currentEdition,
  candidate,
  onCancel,
  onConfirm,
}: {
  currentEdition: UpdateEdition;
  candidate: AppUpdateCandidate;
  onCancel(): void;
  onConfirm(): void;
}) {
  const { t, i18n } = useTranslation();
  const direction = currentEdition === "core" ? "coreToFull" : "fullToCore";
  return (
    <ModalFrame title={t(`updates.editionChange.${direction}.title`)} onClose={onCancel}>
      <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
        <PackageCheck className="mt-0.5 h-5 w-5 flex-none" />
        <p className="text-sm leading-6">
          {t(`updates.editionChange.${direction}.message`)}
        </p>
      </div>
      <div className="mt-4 rounded-lg border border-surface-border bg-surface-elevated p-4">
        <div className="text-sm font-bold text-text-primary">
          JudgeDesk {candidate.version} · {t(`updates.editions.${candidate.edition}.name`)}
        </div>
        <SizeRows candidate={candidate} locale={i18n.language} />
      </div>
      <div className="mt-5 flex justify-end gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-surface-border bg-input-bg px-4 py-2 text-xs font-semibold text-text-primary hover:bg-surface-hover"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-500"
        >
          {t("updates.confirmDownload")}
        </button>
      </div>
    </ModalFrame>
  );
}

export function DonationConfirmDialog({
  onCancel,
  onConfirm,
}: {
  onCancel(): void;
  onConfirm(): void;
}) {
  const { t } = useTranslation();
  return (
    <ModalFrame title={t("donation.openTitle")} onClose={onCancel}>
      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 flex-none items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          <Coffee className="h-6 w-6" />
        </div>
        <p className="text-sm leading-6 text-text-muted">{t("donation.openMessage")}</p>
      </div>
      <div className="mt-5 flex justify-end gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-surface-border bg-input-bg px-4 py-2 text-xs font-semibold text-text-primary hover:bg-surface-hover"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded bg-amber-600 px-4 py-2 text-xs font-bold text-white hover:bg-amber-500"
        >
          {t("donation.openAction")}
        </button>
      </div>
    </ModalFrame>
  );
}

function SizeRows({ candidate, locale }: {
  candidate: AppUpdateCandidate;
  locale: string;
}) {
  const { t } = useTranslation();
  return (
    <dl className="mt-3 space-y-1.5 border-t border-surface-border pt-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <dt className="flex items-center gap-1.5 text-text-muted">
          <Download className="h-3.5 w-3.5" /> {t("updates.downloadSize")}
        </dt>
        <dd className="font-semibold text-text-primary">
          {formatUpdateBytes(candidate.downloadSizeBytes, locale)}
        </dd>
      </div>
      <div className="flex items-center justify-between gap-2">
        <dt className="flex items-center gap-1.5 text-text-muted">
          <HardDrive className="h-3.5 w-3.5" /> {t("updates.installedSize")}
        </dt>
        <dd className="font-semibold text-text-primary">
          {formatUpdateBytes(candidate.installedSizeBytes, locale)}
        </dd>
      </div>
    </dl>
  );
}

function ModalFrame({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
}) {
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-xl overflow-hidden rounded-lg border border-surface-border bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-surface-border bg-surface-elevated px-5 py-4">
          <h2 className="text-sm font-bold text-text-primary">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-muted hover:bg-surface-hover hover:text-text-primary"
            aria-label={title}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-5">{children}</div>
      </div>
    </div>
  );
}
