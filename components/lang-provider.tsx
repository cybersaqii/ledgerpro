"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { tr, loadUrDict, getUrDict, isUrLoaded, LANG_STORAGE_KEY, type Lang, type UrDict } from "@/lib/i18n";

interface LangContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Translate a semantic key, e.g. t("nav.sales") or t("header.trialCta", { days: 5 }) */
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** Loaded Urdu dictionary — null until the user switches to Urdu and its chunk arrives. */
  urDict: UrDict | null;
}

const LangContext = createContext<LangContextValue>({
  lang: "en",
  setLang: () => {},
  t: (key, vars) => tr("en", key, vars),
  urDict: null,
});

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");
  // The Urdu dictionary (~235KB) is never in the initial bundle: it loads as
  // a separate chunk the first time the user picks Urdu. English renders
  // immediately (SSR default) and stays until the chunk arrives.
  const [urDict, setUrDictState] = useState<UrDict | null>(() => (isUrLoaded() ? getUrDict() : null));

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
    if (lang === "ur" && urDict === null) {
      let live = true;
      loadUrDict().then(() => {
        if (live) setUrDictState(getUrDict());
      });
      return () => {
        live = false;
      };
    }
  }, [lang, urDict]);

  useEffect(() => {
    document.documentElement.lang = lang;
    // NOTE: layout stays LTR on purpose — money, quantities and dates must
    // never flip direction in an accounting app. Urdu script still renders
    // right-to-left inside its own text runs.
    try { localStorage.setItem(LANG_STORAGE_KEY, lang); } catch { /* ignore */ }
  }, [lang]);

  const setLang = useCallback((l: Lang) => setLangState(l), []);
  // Re-created when the Urdu chunk lands so every consumer re-renders in Urdu.
  const t = useCallback((key: string, vars?: Record<string, string | number>) => tr(lang, key, vars), [lang, urDict]);

  return <LangContext.Provider value={{ lang, setLang, t, urDict }}>{children}</LangContext.Provider>;
}

export function useLang(): LangContextValue {
  return useContext(LangContext);
}

/** Shorthand most pages use: const { t } = useT(); */
export function useT(): LangContextValue {
  return useContext(LangContext);
}
