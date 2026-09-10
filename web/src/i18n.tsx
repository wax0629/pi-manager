import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { translate, type Locale, type MessageParams } from './i18n-messages';

export type { Locale, MessageParams };
export type Translate = (key: string, params?: MessageParams) => string;

const STORAGE_KEY = 'pi-manager.locale';

export function detectLocale(): Locale {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  }
  if (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')) return 'zh';
  return 'en';
}

type I18nValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
};

const I18nContext = createContext<I18nValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale());

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    localStorage.setItem(STORAGE_KEY, locale);
  }, [locale]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => document.documentElement.classList.toggle('dark', media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  const value = useMemo<I18nValue>(() => ({
    locale,
    setLocale: setLocaleState,
    t: (key, params) => translate(locale, key, params),
  }), [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside LocaleProvider');
  return value;
}
