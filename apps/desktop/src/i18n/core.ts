import config from '../../i18n.config.json' with { type: 'json' };

export interface LanguageConfig {
  fallbackLocale: string;
  storageKey: string;
  locales: Readonly<Record<string, { label: string; systemLanguages: readonly string[] }>>;
  messages: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

// All language-specific choices belong in the configuration, not the switching logic.
export function createLanguageSupport<const C extends LanguageConfig>(config: C) {
  type Locale = Extract<keyof C['locales'], string>;
  type Preference = Locale | 'system';
  if (!Object.hasOwn(config.locales, config.fallbackLocale))
    throw new Error('The fallback locale must be registered in the language configuration.');
  const fallback = config.fallbackLocale as Locale;
  const languageOptions = Object.entries(config.locales).map(([value, { label }]) => ({
    value: value as Locale,
    label,
  }));

  function normalizePreference(value: unknown): Preference {
    return typeof value === 'string' && Object.hasOwn(config.locales, value)
      ? (value as Locale)
      : 'system';
  }

  function systemLocale(languages: readonly string[]): Locale {
    const primary = (languages[0] || '').toLowerCase();
    let selected = fallback;
    let specificity = 0;
    for (const [locale, { systemLanguages }] of Object.entries(config.locales)) {
      for (const tag of systemLanguages) {
        const prefix = tag.toLowerCase();
        if (
          prefix.length > specificity &&
          (primary === prefix || primary.startsWith(`${prefix}-`))
        ) {
          selected = locale as Locale;
          specificity = prefix.length;
        }
      }
    }
    return selected;
  }

  function readPreference(storage: Pick<Storage, 'getItem'>): Preference {
    try {
      return normalizePreference(storage.getItem(config.storageKey));
    } catch {
      return 'system';
    }
  }

  function savePreference(storage: Pick<Storage, 'setItem'>, value: Preference) {
    try {
      storage.setItem(config.storageKey, value);
    } catch {
      // An unavailable preference store must not prevent switching the current UI.
    }
  }

  function translate(
    locale: Locale,
    message: string,
    values?: Record<string, string | number | undefined>,
  ): string {
    // Electron adds a transport wrapper to rejected invoke calls. Translate
    // known application diagnostics while retaining unknown diagnostics intact.
    const remote = /^(?:Error: )?Error invoking remote method '[^']+': (?:Error: )?([\s\S]+)$/.exec(
      message,
    );
    if (remote && Object.hasOwn(config.messages, remote[1])) message = remote[1];
    const prefix = message.startsWith('Error: ') ? 'Error: ' : '';
    const key = prefix ? message.slice(prefix.length) : message;
    const entry = Object.hasOwn(config.messages, key) ? config.messages[key] : undefined;
    const result = entry?.[locale] ?? entry?.[fallback] ?? key;
    return (
      prefix +
      result.replace(/\{(\w+)\}/g, (token, name: string) =>
        values && Object.hasOwn(values, name) ? String(values[name]) : token,
      )
    );
  }

  return {
    languageOptions,
    languageStorageKey: config.storageKey,
    normalizePreference,
    systemLocale,
    readPreference,
    savePreference,
    translate,
  };
}

export type Locale = keyof typeof config.locales;
export type LanguagePreference = Locale | 'system';
export const {
  languageOptions,
  languageStorageKey,
  normalizePreference,
  systemLocale,
  readPreference,
  savePreference,
  translate,
} = createLanguageSupport(config);
