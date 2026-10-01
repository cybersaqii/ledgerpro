"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { api } from "@/lib/format";
import { useLang } from "./lang-provider";
import { fmtDateTime } from "@/lib/format";

interface NotifItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  createdAt: string;
}

/** Notification bell in the topbar: unread dot + dropdown + mark-read. */
export function NotificationBell() {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotifItem[]>([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const d = await api<{ data: { items: NotifItem[]; unread: number } }>(
        "/api/notifications?limit=10"
      );
      setItems(d.data.items);
      setUnread(d.data.unread);
    } catch {
      // Notifications are non-critical — a failure must not break the shell.
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- notification feed fetch on mount
    load();
    const id = setInterval(load, 120000); // refresh every 2 minutes
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const markRead = async (id: string) => {
    try {
      await api("/api/notifications/read", { method: "POST", body: JSON.stringify({ id }) });
      setItems((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
      setUnread((u) => Math.max(0, u - 1));
    } catch {
      /* best-effort */
    }
  };

  const markAll = async () => {
    try {
      await api("/api/notifications/read", { method: "POST", body: JSON.stringify({ id: "all" }) });
      setItems((prev) => prev.map((n) => ({ ...n, isRead: true })));
      setUnread(0);
    } catch {
      /* best-effort */
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative grid h-11 w-11 place-items-center rounded-xl border border-border bg-card transition hover:-translate-y-0.5 hover:shadow-md"
        aria-label={t("header.notifications")}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Bell size={17} />
        {unread > 0 && (
          <span className="absolute end-1.5 top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1 text-[10px] font-extrabold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div role="menu" className="modal-pop absolute end-0 z-40 mt-2 w-80 overflow-hidden rounded-2xl border border-border bg-card shadow-xl sm:w-96">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <p className="text-sm font-extrabold">{t("header.notifications")}</p>
            <div className="flex items-center gap-2">
              {unread > 0 && (
                <button onClick={markAll} className="text-xs font-bold text-primary hover:underline">
                  {t("header.markAllRead")}
                </button>
              )}
              <Link href="/notifications" onClick={() => setOpen(false)} className="text-xs font-bold text-primary hover:underline">
                {t("header.viewAllNotifications")}
              </Link>
            </div>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t("header.noNotifications")}</p>
            )}
            {items.map((n) => (
              <div
                key={n.id}
                className={`border-b border-border/60 px-4 py-3 transition last:border-0 hover:bg-muted/60 ${n.isRead ? "" : "bg-primary/5"}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    {n.link ? (
                      <Link
                        href={n.link}
                        onClick={() => { markRead(n.id); setOpen(false); }}
                        className="block truncate text-sm font-bold hover:text-primary"
                      >
                        {n.title}
                      </Link>
                    ) : (
                      <p className="truncate text-sm font-bold">{n.title}</p>
                    )}
                    {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.body}</p>}
                    <p className="mt-1 text-[11px] text-muted-foreground">{fmtDateTime(n.createdAt)}</p>
                  </div>
                  {!n.isRead && (
                    <button
                      onClick={() => markRead(n.id)}
                      className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-primary"
                      aria-label={t("header.markAllRead")}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
