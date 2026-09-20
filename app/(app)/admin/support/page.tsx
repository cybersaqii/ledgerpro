"use client";

import { useEffect, useState } from "react";
import { Inbox, Check, RotateCcw } from "lucide-react";
import { PageHeader, ErrorNote, EmptyState } from "@/components/ui";
import { api } from "@/lib/format";

type Request = {
  id: string; name: string; email: string; subject: string;
  message: string; status: string; createdAt: string;
};

export default function AdminSupportPage() {
  const [rows, setRows] = useState<Request[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("OPEN");
  const [busy, setBusy] = useState<string | null>(null);

  async function load(status: string) {
    setError(null);
    try {
      const d = await api<{ data: Request[] }>(`/api/admin/support?status=${status}`);
      setRows(d.data);
      setForbidden(false);
    } catch (e) {
      if (e instanceof Error && /not authorized/i.test(e.message)) setForbidden(true);
      else setError(e instanceof Error ? e.message : "Could not load requests.");
    }
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      if (alive) {
        await load("OPEN");
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => { if (alive) await load(filter); })();
    return () => { alive = false; };
  }, [filter]);

  async function setStatus(id: string, status: "OPEN" | "RESOLVED") {
    setBusy(id); setError(null);
    try {
      await api(`/api/admin/support/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      await load(filter);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update.");
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <PageHeader title="Support requests" subtitle="Inbox" icon={<Inbox size={22} />} />;
  if (forbidden) return (
    <div className="space-y-4">
      <PageHeader title="Support requests" subtitle="Inbox" icon={<Inbox size={22} />} />
      <EmptyState title="Not authorized" hint="This area is only for the platform admin." />
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Support requests" subtitle="Messages from the public support form" icon={<Inbox size={22} />} />
      <ErrorNote message={error} />
      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-bold">Inbox</p>
          <div className="flex gap-2">
            {(["OPEN", "RESOLVED", "ALL"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className={`rounded-full px-3.5 py-1.5 text-sm font-bold ${filter === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
              >
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="mt-3"><EmptyState title={`No ${filter.toLowerCase()} requests`} /></div>
        ) : (
          <div className="mt-4 space-y-3">
            {rows.map((r) => (
              <div key={r.id} className="rounded-2xl border border-border p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-bold">{r.subject}</p>
                    <p className="text-sm text-muted-foreground">
                      {r.name} · <a className="font-semibold text-primary hover:underline" href={`mailto:${r.email}`}>{r.email}</a>
                    </p>
                    <p className="text-xs text-muted-foreground">{r.createdAt.slice(0, 16).replace("T", " ")}</p>
                  </div>
                  <button
                    onClick={() => setStatus(r.id, r.status === "OPEN" ? "RESOLVED" : "OPEN")}
                    disabled={busy === r.id}
                    className="btn btn-ghost !py-2 text-sm"
                  >
                    {r.status === "OPEN" ? <><Check size={15} /> Mark resolved</> : <><RotateCcw size={15} /> Reopen</>}
                  </button>
                </div>
                <p className="mt-3 whitespace-pre-wrap rounded-xl bg-muted/60 px-4 py-3 text-sm leading-relaxed">{r.message}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
