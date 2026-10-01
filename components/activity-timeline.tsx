"use client";

import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";
import { api, fmtDateTime } from "@/lib/format";

type Entry = {
  id: string;
  userName: string;
  action: string;
  entity: string;
  detail: string;
  ip: string | null;
  createdAt: string;
};

/** Module 6.4 — document activity timeline: the audit-log entries for one
 * entity (invoice, bill, payment, approval) shown under the document. */
export function ActivityTimeline({ entity, entityId }: { entity: string; entityId: string }) {
  const { t } = useLang();
  const { permissions, loading: permsLoading } = usePermissions();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const canView = !permsLoading && permissions.includes("audit");

  useEffect(() => {
    if (!open || loaded || !canView) return;
    api<{ data: Entry[] }>(`/api/audit?entity=${encodeURIComponent(entity)}&entityId=${encodeURIComponent(entityId)}`)
      .then((d) => setEntries(d.data))
      .catch(() => setEntries([]))
      .finally(() => setLoaded(true));
  }, [open, loaded, canView, entity, entityId]);

  if (!canView) return null;

  return (
    <div className="card mt-6 p-4 sm:p-5">
      <button
        className="flex w-full items-center justify-between text-start"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 font-extrabold">
          <History size={18} className="text-primary" /> {t("activity.title")}
        </span>
        <span className="text-xs font-bold text-muted-foreground">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="mt-4">
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("activity.empty")}</p>
          ) : (
            <ol className="relative space-y-4 border-s-2 border-border ps-4">
              {entries.map((e) => (
                <li key={e.id} className="relative">
                  <span className="absolute -start-[21px] top-1 h-2.5 w-2.5 rounded-full bg-primary ring-4 ring-primary/15" />
                  <p className="text-sm font-bold">{e.detail || e.action}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {e.userName} · {fmtDateTime(e.createdAt)}
                    {e.ip && ` · ${e.ip}`}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
