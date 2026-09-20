"use client";

import { useState } from "react";
import { Send, CheckCircle2 } from "lucide-react";
import { Field, ErrorNote } from "@/components/ui";
import { useLang } from "@/components/lang-provider";

export default function SupportForm() {
  const { t } = useLang();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, subject, message }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t("supportform.sendError"));
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("supportform.sendError"));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="mt-6 rounded-2xl bg-primary-soft p-6 text-center">
        <CheckCircle2 size={32} className="mx-auto text-primary" />
        <p className="mt-3 font-extrabold">{t("supportform.sentTitle")}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t("supportform.sentSub")}</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <ErrorNote message={error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("supportform.nameLabel")}>
          <input className="field" required minLength={2} maxLength={80} value={name}
            onChange={(e) => setName(e.target.value)} placeholder={t("supportform.namePh")} autoComplete="name" />
        </Field>
        <Field label={t("supportform.emailLabel")}>
          <input className="field" required type="email" maxLength={120} value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
        </Field>
      </div>
      <Field label={t("supportform.subjectLabel")}>
        <input className="field" required minLength={3} maxLength={120} value={subject}
          onChange={(e) => setSubject(e.target.value)} placeholder={t("supportform.subjectPh")} />
      </Field>
      <Field label={t("supportform.messageLabel")}>
        <textarea className="field min-h-32" required minLength={10} maxLength={4000} value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t("supportform.messagePh")} />
      </Field>
      <button className="btn btn-primary" disabled={busy}>
        <Send size={16} /> {busy ? t("supportform.sending") : t("supportform.sendBtn")}
      </button>
    </form>
  );
}
