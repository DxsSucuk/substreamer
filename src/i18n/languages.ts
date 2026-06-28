export interface Language {
  code: string;
  name: string;
  nativeName: string;
}

export const SUPPORTED_LANGUAGES: Language[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'zh-Hans', name: 'Chinese (Simplified)', nativeName: '简体中文' },
  { code: 'zh-Hant', name: 'Chinese (Traditional)', nativeName: '繁體中文' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  // Future: add languages as Crowdin translations are ready
  // { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
  // { code: 'ko', name: 'Korean', nativeName: '한국어' },
  // { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
];

export const SUPPORTED_LOCALE_CODES = SUPPORTED_LANGUAGES.map((l) => l.code);
