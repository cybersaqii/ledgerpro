"use client";

import { useEffect, useState } from "react";
import { LifeBuoy, Send, Clock } from "lucide-react";
import { PageHeader, Field, ErrorNote, EmptyState } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { api, fmtDate } from "@/lib/format";

type Request = {
  id: string;
  subject: string;
  message: string;
  status: string;
  createdAt: string;
};

export default function SupportPage() {
  const { t } = useLang();
  const [requests, setRequests] = useState<Request[]>([]);
  const [loading, setLoading] = useState(true);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sent, setSent] = useState(false);

  const load = () => {
    api<{ data: Request[] }>("/api/support/mine")
      .then((d) => setRequests(d.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const send = async () => {
    if (!subject.trim() || message.trim().length < 10) return;
    setBusy(true); setErr("");
    try {
      await api("/api/support/mine", {
        method: "POST",
        body: JSON.stringify({ subject: subject.trim(), message: message.trim() }),
      });
      setSubject(""); setMessage("");
      setSent(true);
      setTimeout(() => setSent(false), 3000);
      load();
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t("mysupport.title")} subtitle={t("mysupport.subtitle")} icon={<LifeBuoy size={22} />} />
      <ErrorNote message={err} />

      {/* New message */}
      <div className="card p-5 sm:p-6">
        <p className="font-extrabold">{t("mysupport.newMessage")}</p>
        <div className="mt-4 space-y-4">
          <Field label={t("mysupport.subject")} required>
            <input className="field" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t("mysupport.subjectPh")} maxLength={120} />
          </Field>
          <Field label={t("mysupport.message")} required>
            <textarea className="field min-h-32" value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t("mysupport.messagePh")} maxLength={4000} />
          </Field>
        </div>
        {sent && <p className="mt-3 text-sm font-bold text-success">{t("mysupport.sent")}</p>}
        <div className="mt-4 flex justify-end">
          <button className="btn btn-primary" disabled={busy || !subject.trim() || message.trim().length < 10} onClick={send}>
            <Send size={15} /> {busy ? "…" : t("mysupport.send")}
          </button>
        </div>
      </div>

      {/* History */}
      <div className="card p-5 sm:p-6">
        <p className="font-extrabold">{t("mysupport.history")}</p>
        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : requests.length === 0 ? (
          <div className="mt-2"><EmptyState title={t("mysupport.noRequests")} hint={t("mysupport.noRequestsHint")} /></div>
        ) : (
          <div className="mt-4 space-y-3">
            {requests.map((r) => (
              <div key={r.id} className="rounded-2xl border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-bold">{r.subject}</p>
                  <span className={`badge ${r.status === "OPEN" ? "bg-warning-soft text-warning" : "bg-success-soft text-success"}`}>
                    {r.status === "OPEN" ? t("mysupport.open") : t("mysupport.resolved")}
                  </span>
                </div>
                <p className="mt-1.5 text-sm text-muted-foreground">{r.message}</p>
                <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock size={12} /> {fmtDate(r.createdAt)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
