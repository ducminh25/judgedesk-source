import React, { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AnnouncementImage } from "../../../shared/announcements.js";
import type { AnnouncementClient } from "./announcement-client.js";

export function AnnouncementMedia({ image, alt, load, thumbnail = false }: {
  image: AnnouncementImage; alt: string; load: () => Promise<ArrayBuffer>; thumbnail?: boolean;
}) {
  const { t } = useTranslation();
  const host = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(!thumbnail);
  const [source, setSource] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!thumbnail || !host.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "80px" });
    observer.observe(host.current); return () => observer.disconnect();
  }, [thumbnail]);
  useEffect(() => {
    if (!visible) return;
    let disposed = false; let url: string | undefined;
    setSource(undefined); setFailed(false);
    void load().then((bytes) => {
      if (disposed) return;
      url = URL.createObjectURL(new Blob([bytes], { type: image.mime })); setSource(url);
    }).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; if (url) URL.revokeObjectURL(url); };
  }, [visible, image.sha256, image.mime, load]);
  return <span ref={host} className={thumbnail ? "announcement-thumbnail" : "announcement-image"}>
    {source ? <img src={source} alt={alt} onError={() => setFailed(true)} hidden={failed} /> : null}
    {!source || failed ? thumbnail ? <Bell className="h-5 w-5" aria-hidden="true" /> : <span role="status">{t(failed ? "announcements.imageError" : "announcements.imageLoading")}</span> : null}
  </span>;
}

export type { AnnouncementClient };
