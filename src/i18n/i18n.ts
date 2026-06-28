// Hermes Intl polyfills — MUST be the first imports in the entire app.
//
// Hermes ships only a partial native Intl implementation on Android and
// relies on platform ICU data. Stripped OEM ROMs (MIUI/HyperOS, FunTouchOS)
// can be missing or have broken ICU, which causes Hermes to throw
// JSRangeErrorException from .toLocaleString() / Intl.NumberFormat /
// Intl.DateTimeFormat at module init or first use — crashing the JS
// bundle before any error boundary mounts.
//
// We polyfill all three Intl APIs we use, with /polyfill-force so the
// formatjs detection code (which is itself slow on Hermes) is bypassed.
//
// When adding a new locale to languages.ts, ALL THREE locale-data lists
// below must be extended together, plus the pluralrules block.
import '@formatjs/intl-getcanonicallocales/polyfill-force.js';
import '@formatjs/intl-locale/polyfill-force.js';

import '@formatjs/intl-pluralrules/polyfill-force.js';
import '@formatjs/intl-pluralrules/locale-data/en.js';
import '@formatjs/intl-pluralrules/locale-data/fr.js';
import '@formatjs/intl-pluralrules/locale-data/de.js';
import '@formatjs/intl-pluralrules/locale-data/es.js';
import '@formatjs/intl-pluralrules/locale-data/it.js';
import '@formatjs/intl-pluralrules/locale-data/ru.js';
import '@formatjs/intl-pluralrules/locale-data/zh.js';

import '@formatjs/intl-numberformat/polyfill-force.js';
import '@formatjs/intl-numberformat/locale-data/en.js';
import '@formatjs/intl-numberformat/locale-data/fr.js';
import '@formatjs/intl-numberformat/locale-data/de.js';
import '@formatjs/intl-numberformat/locale-data/es.js';
import '@formatjs/intl-numberformat/locale-data/it.js';
import '@formatjs/intl-numberformat/locale-data/ru.js';
import '@formatjs/intl-numberformat/locale-data/zh.js';

import '@formatjs/intl-datetimeformat/polyfill-force.js';
import '@formatjs/intl-datetimeformat/add-all-tz.js';
import '@formatjs/intl-datetimeformat/locale-data/en.js';
import '@formatjs/intl-datetimeformat/locale-data/fr.js';
import '@formatjs/intl-datetimeformat/locale-data/de.js';
import '@formatjs/intl-datetimeformat/locale-data/es.js';
import '@formatjs/intl-datetimeformat/locale-data/it.js';
import '@formatjs/intl-datetimeformat/locale-data/ru.js';
import '@formatjs/intl-datetimeformat/locale-data/zh.js';

import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getCalendars, getLocales } from 'expo-localization';

// `@formatjs/intl-datetimeformat` (force-polyfilled above) defaults its
// timezone to UTC — without this, EVERY Intl-formatted time renders in UTC.
// The hour bucketing uses native `Date.getHours()` (already local), but the
// chart labels / "peak hour" text go through Intl, so they appeared shifted by
// the device's UTC offset (e.g. a 1 PM peak labelled "1 AM" for +12 users).
// Point the polyfill at the device timezone; `add-all-tz` is already loaded.
try {
  const deviceTimeZone = getCalendars()[0]?.timeZone;
  const DTF = Intl.DateTimeFormat as unknown as {
    __setDefaultTimeZone?: (tz: string) => void;
  };
  if (deviceTimeZone && typeof DTF.__setDefaultTimeZone === 'function') {
    DTF.__setDefaultTimeZone(deviceTimeZone);
  }
} catch {
  // Native timezone unavailable (e.g. tests) — fall back to the UTC default.
}

// Locale JSON imports — add new imports here when enabling a language
import en from './locales/en.json';
import fr from './locales/fr.json';
import de from './locales/de.json';
import es from './locales/es.json';
import it from './locales/it.json';
import ru from './locales/ru.json';
import zhHans from './locales/zh-Hans.json';
import zhHant from './locales/zh-Hant.json';
import ja from './locales/ja.json';

import { SUPPORTED_LOCALE_CODES } from './languages';
import { localeStore } from '../store/localeStore';

/** Registry mapping locale code to its translation bundle. */
const localeResources: Record<string, { translation: Record<string, string> }> = {
  en: { translation: en },
  fr: { translation: fr },
  de: { translation: de },
  es: { translation: es },
  it: { translation: it },
  ru: { translation: ru },
  'zh-Hans': { translation: zhHans },
  'zh-Hant': { translation: zhHant },
  ja: { translation: ja },
  // Add new entries here when enabling a language
};

/** Regions that use Traditional Chinese by convention. */
const ZH_HANT_REGIONS = new Set(['TW', 'HK', 'MO']);

/**
 * Resolve a BCP-47 language tag (e.g. "zh-Hans-CN", "ru-RU", "en-US") to the
 * supported app locale code. Handles the Simplified vs Traditional Chinese
 * split explicitly; other languages fall through to their 2-letter code.
 */
export function resolveAppLocale(tag: string | undefined | null): string | null {
  if (!tag) return null;
  const parts = tag.split('-');
  const language = parts[0]?.toLowerCase();
  if (!language) return null;

  if (language === 'zh') {
    // Inspect subtags after the language code for script / region hints.
    const subtags = parts.slice(1);
    const script = subtags.find((p) => p.length === 4);
    const region = subtags.find((p) => p.length === 2)?.toUpperCase();
    if (script) {
      if (script === 'Hant') return 'zh-Hant';
      if (script === 'Hans') return 'zh-Hans';
    }
    if (region && ZH_HANT_REGIONS.has(region)) return 'zh-Hant';
    return 'zh-Hans';
  }

  return language;
}

function getDeviceLocale(): string {
  try {
    const locales = getLocales();
    const first = locales[0];
    if (!first) return 'en';
    // Prefer the full BCP-47 tag so we can distinguish zh-Hans vs zh-Hant.
    // Fall back to languageCode for older expo-localization runtimes.
    const tag = first.languageTag ?? first.languageCode ?? null;
    return resolveAppLocale(tag) ?? 'en';
  } catch {
    return 'en';
  }
}

function getInitialLocale(): string {
  const stored = localeStore.getState().locale;
  if (stored && SUPPORTED_LOCALE_CODES.includes(stored)) return stored;
  const device = getDeviceLocale();
  if (SUPPORTED_LOCALE_CODES.includes(device)) return device;
  return 'en';
}

i18next
  .use(initReactI18next)
  .init({
    lng: getInitialLocale(),
    fallbackLng: 'en',
    ns: ['translation'],
    defaultNS: 'translation',
    resources: localeResources,
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
  });

export default i18next;
