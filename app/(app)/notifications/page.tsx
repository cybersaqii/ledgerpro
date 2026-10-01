"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell, CheckCheck } from "lucide-react";
import { PageHeader, EmptyState, ErrorNote } from "@/components/ui";
import { api, fmtDateTime } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

interface NotifItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  createdAt: string;
}

const KIND_TONE: Record<string, string> = {
  REMINDER: "text-amber-600 dark:text-amber-400",
  LOW_STOCK: "text-danger",
  SYSTEM: "text-primary",
};

export default function NotificationsPage() {
  const { t } = useLang();
  const [items, setItems] = useState<NotifItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api<{ data: { items: NotifItem[] } }>("/api/notifications?limit=100")
      .then((d) => {
        setItems(d.data.items);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Error"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- notification feed fetch on mount
    load();
  }, []);

  const markAll = async () => {
    try {
      await api("/api/notifications/read", { method: "POST", body: JSON.stringify({ id: "all" }) });
      setItems((prev) => prev.map((n) => ({ ...n, isRead: true })));
    } catch { /* best-effort */ }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title={t("header.notifications")}
        icon={<Bell size={20} />}
        actions={
          <button onClick={markAll} className="btn-secondary inline-flex items-center gap-2">
            <CheckCheck size={15} /> {t("header.markAllRead")}
          </button>
        }
      />
      <ErrorNote message={error} />
      {loading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-20 rounded-2xl" />)}</div>
      ) : items.length === 0 ? (
        <EmptyState title={t("header.noNotifications")} icon={<Bell size={28} />} />
      ) : (
        <div className="card card-gloss divide-y divide-border overflow-hidden">
          {items.map((n) => (
            <div key={n.id} className={`px-5 py-4 ${n.isRead ? "" : "bg-primary/5"}`}>
              <div className="flex items-start gap-3">
                <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${n.isRead ? "bg-muted" : "bg-primary"}`} />
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-bold ${KIND_TONE[n.kind] ?? ""}`}>{n.title}</p>
                  {n.body && <p className="mt-1 text-sm text-muted-foreground">{n.body}</p>}
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <span className="text-xs text-muted-foreground">{fmtDateTime(n.createdAt)}</span>
                    {n.link && (
                      <Link href={n.link} className="text-xs font-bold text-primary hover:underline">
                        {t("common.view")}
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
