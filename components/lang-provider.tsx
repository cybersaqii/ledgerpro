"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { tr, LANG_STORAGE_KEY, type Lang } from "@/lib/i18n";

interface LangContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Translate a semantic key, e.g. t("nav.sales") or t("header.trialCta", { days: 5 }) */
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const LangContext = createContext<LangContextValue>({
  lang: "en",
  setLang: () => {},
  t: (key, vars) => tr("en", key, vars),
});

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");

  // Read from storage in an effect (not lazy init): localStorage does not
  // exist during SSR, and lazy init would hydrate "ur" against server "en".
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LANG_STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate saved language after mount
      if (saved === "ur" || saved === "en") setLangState(saved);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    // NOTE: layout stays LTR on purpose — money, quantities and dates must
    // never flip direction in an accounting app. Urdu script still renders
    // right-to-left inside its own text runs.
    try { localStorage.setItem(LANG_STORAGE_KEY, lang); } catch { /* ignore */ }
  }, [lang]);

  const setLang = useCallback((l: Lang) => setLangState(l), []);
  const t = useCallback((key: string, vars?: Record<string, string | number>) => tr(lang, key, vars), [lang]);

  return <LangContext.Provider value={{ lang, setLang, t }}>{children}</LangContext.Provider>;
}

export function useLang(): LangContextValue {
  return useContext(LangContext);
}

/** Shorthand most pages use: const { t } = useT(); */
export function useT(): LangContextValue {
  return useContext(LangContext);
}
