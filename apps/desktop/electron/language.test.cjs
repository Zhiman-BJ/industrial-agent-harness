const assert = require('node:assert/strict');
const { test } = require('node:test');

const core = import('../src/i18n/core.ts');

test('language follows the primary system language, with a safe English fallback', async () => {
  const { systemLocale, normalizePreference } = await core;
  assert.equal(systemLocale(['zh-CN', 'en-US']), 'zh-CN');
  assert.equal(systemLocale(['zh-Hant-TW']), 'zh-CN');
  assert.equal(systemLocale(['en-GB', 'zh-CN']), 'en');
  assert.equal(systemLocale(['de-DE']), 'en');
  assert.equal(systemLocale([]), 'en');
  for (const value of [null, undefined, '', 'invalid', '{}'])
    assert.equal(normalizePreference(value), 'system');
  assert.equal(normalizePreference('en'), 'en');
  assert.equal(normalizePreference('zh-CN'), 'zh-CN');
});

test('preferences persist and unavailable storage does not prevent switching', async () => {
  const { readPreference, savePreference, languageStorageKey } = await core;
  const data = new Map();
  const storage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
  assert.equal(readPreference(storage), 'system');
  for (const choice of ['zh-CN', 'en', 'system']) {
    savePreference(storage, choice);
    assert.equal(data.get(languageStorageKey), choice);
    assert.equal(readPreference(storage), choice);
  }
  const blocked = {
    getItem() {
      throw Error('Storage disabled');
    },
    setItem() {
      throw Error('Storage disabled');
    },
  };
  assert.equal(readPreference(blocked), 'system');
  assert.doesNotThrow(() => savePreference(blocked, 'zh-CN'));
});

test('translations preserve data, interpolate once, and fall back for unknown messages', async () => {
  const { translate } = await core;
  assert.equal(translate('zh-CN', 'Settings'), '设置');
  assert.equal(translate('en', 'Settings'), 'Settings');
  assert.equal(translate('en', '草图与约束'), 'Sketches and constraints');
  assert.equal(translate('zh-CN', 'Error: Wait for the chat to open.'), 'Error: 请等待聊天打开。');
  const name = '<img src=x> 中文 {0} $&';
  assert.equal(translate('zh-CN', 'New chat in {0}', { 0: name }), `在 ${name} 中新建聊天`);
  assert.equal(
    translate('en', 'Unregistered runtime diagnostic'),
    'Unregistered runtime diagnostic',
  );
  assert.equal(translate('en', 'New chat in {0}'), 'New chat in {0}');
});

test('configuration translations use registered locales and matching interpolation parameters', () => {
  const { messages, locales, fallbackLocale } = require('../i18n.config.json');
  const parameters = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  assert.ok(Object.hasOwn(locales, fallbackLocale));
  assert.ok(!Object.hasOwn(locales, 'system'), 'system is reserved for following the OS');
  for (const [locale, definition] of Object.entries(locales)) {
    assert.doesNotThrow(() => new Intl.DateTimeFormat(locale));
    assert.ok(definition.label.trim(), locale);
    assert.ok(
      definition.systemLanguages.every(tag => typeof tag === 'string' && tag.trim()),
      locale,
    );
  }
  for (const [key, translations] of Object.entries(messages)) {
    assert.ok(translations[fallbackLocale]?.trim(), `Missing fallback: ${key}`);
    for (const [locale, text] of Object.entries(translations)) {
      assert.ok(Object.hasOwn(locales, locale), `Unregistered locale: ${key} / ${locale}`);
      assert.ok(typeof text === 'string' && text.trim(), `${key} / ${locale}`);
      assert.deepEqual(
        parameters(translations[fallbackLocale]),
        parameters(text),
        `${key} / ${locale}`,
      );
    }
  }
});

test('a third language needs only configuration for options, detection, persistence and fallback', async () => {
  const { createLanguageSupport } = await core;
  const config = require('../i18n.config.json');
  const french = createLanguageSupport({
    ...config,
    locales: { ...config.locales, fr: { label: 'Français', systemLanguages: ['fr'] } },
    messages: {
      ...config.messages,
      Settings: { ...config.messages.Settings, fr: 'Paramètres' },
      'New chat in {0}': {
        ...config.messages['New chat in {0}'],
        fr: 'Nouvelle discussion dans {0}',
      },
    },
  });
  assert.deepEqual(french.languageOptions.at(-1), { value: 'fr', label: 'Français' });
  assert.equal(french.normalizePreference('fr'), 'fr');
  assert.equal(french.systemLocale(['fr-CA', 'en-US']), 'fr');
  assert.equal(french.systemLocale(['french']), 'en');
  assert.equal(french.translate('fr', 'Settings'), 'Paramètres');
  assert.equal(
    french.translate('fr', 'New chat in {0}', { 0: '项目 {0}' }),
    'Nouvelle discussion dans 项目 {0}',
  );
  assert.equal(french.translate('fr', '草图与约束'), 'Sketches and constraints');
  let saved;
  const storage = {
    getItem: () => saved ?? null,
    setItem: (_key, value) => {
      saved = value;
    },
  };
  french.savePreference(storage, 'fr');
  assert.equal(french.readPreference(storage), 'fr');
  // Removing a configured language makes a saved preference fall back safely.
  assert.equal((await core).readPreference(storage), 'system');
  for (const value of ['__proto__', 'constructor', 'toString'])
    assert.equal(french.normalizePreference(value), 'system');
  assert.equal(french.translate('fr', 'constructor'), 'constructor');
});

test('configured regional languages take precedence and the fallback is configurable', async () => {
  const { createLanguageSupport } = await core;
  const config = require('../i18n.config.json');
  const regional = createLanguageSupport({
    ...config,
    fallbackLocale: 'zh-CN',
    locales: {
      ...config.locales,
      'zh-TW': { label: '繁體中文', systemLanguages: ['zh-TW', 'zh-Hant'] },
    },
  });
  assert.equal(regional.systemLocale(['zh-Hant-TW']), 'zh-TW');
  assert.equal(regional.systemLocale(['ZH-tw']), 'zh-TW');
  assert.equal(regional.systemLocale(['zh-Hans']), 'zh-CN');
  assert.equal(regional.systemLocale(['de-DE']), 'zh-CN');
  assert.equal(regional.translate('zh-TW', 'Settings'), '设置');
  assert.throws(
    () => createLanguageSupport({ ...config, fallbackLocale: 'missing' }),
    /fallback locale/,
  );
});

test('turn-end statuses translate instead of leaking English next to a translated label', async () => {
  const { translate } = await core;
  const { messages } = require('../i18n.config.json');
  // AgentFlow renders t('Turn') + t(event.result.status) on one line; this list
  // mirrors the done-result statuses emitted by the Kimi adapter and the
  // application layer (plus the recording fixtures' 'success'). An entry here
  // must exist in the dictionary or Chinese shows "轮次 finished" mixed text.
  const statuses = [
    'finished',
    'cancelled',
    'error',
    'completed',
    'interrupted',
    'incomplete',
    'success',
  ];
  for (const status of statuses) {
    assert.ok(Object.hasOwn(messages, status), `Missing turn-status entry: ${status}`);
    for (const locale of ['en', 'zh-CN'])
      assert.ok(translate(locale, status).trim(), `${status} / ${locale}`);
    assert.equal(translate('zh-CN', 'Turn'), '轮次');
  }
});
