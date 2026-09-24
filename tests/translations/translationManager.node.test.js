/**
 * translations/index.js in a Node context (CLI / Electron main): no `window`,
 * the language comes from the settings facade and the tables are `require`d.
 * The browser paths live in translationManager.browser.test.js.
 */

const english = require('../../src/js/translations/english');
const latvian = require('../../src/js/translations/latvian');

const SETTINGS = '../../src/js/settings';
const LOGGER = '../../src/js/logger';
const INDEX = '../../src/js/translations/index';

/**
 * Fresh module instance (the cache and manager are module-level). A reset
 * registry rather than isolateModules: the manager `require`s settings/logger
 * lazily, long after load, and those calls must hit the same registry the test
 * inspects.
 */
const load = (setup = () => {}) => {
    jest.resetModules();
    setup();
    const logger = require(LOGGER);
    return { ...require(INDEX), logger };
};

/** Let the constructor's un-awaited init() finish (no timers on the Node path). */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const withCategoryLog = (logger) => {
    const log = { warning: jest.fn(), error: jest.fn() };
    logger.withCategory.mockReturnValue(log);
    return log;
};

const settingsMock =
    (language, extra = {}) =>
    () =>
        jest.doMock(SETTINGS, () => ({ getSetting: jest.fn(() => language), setSetting: jest.fn(), ...extra }));

afterEach(() => {
    jest.dontMock(SETTINGS);
    jest.dontMock('../../src/js/translations/english');
    jest.dontMock('../../src/js/translations/latvian');
});

describe('startup', () => {
    test('loads the saved language from the settings facade', async () => {
        const { translationManager, translations } = load(settingsMock('lv'));
        await flush();
        expect(translationManager.initialized).toBe(true);
        expect(translationManager.getCurrentLanguage()).toBe('lv');
        expect(translations.lv).toEqual(latvian);
        expect(translationManager.t('common.dark')).toBe(latvian.common.dark);
    });

    test('an unloadable settings module is logged and leaves no language selected', async () => {
        const { translationManager, logger } = load(() => {
            jest.doMock(SETTINGS, () => {
                throw new Error('settings unavailable');
            });
        });
        const log = withCategoryLog(logger);
        // The constructor's init already ran with the default mock; re-run it
        // now that the log capture is in place.
        await translationManager.init();
        expect(log.warning).toHaveBeenCalledWith('Could not load language from settings (Node.js):', expect.any(Error));
        expect(translationManager.getCurrentLanguage()).toBeUndefined();
    });
});

describe('loadTranslations', () => {
    test('caches a table and serves it from the cache next time', async () => {
        const { translationManager } = load(settingsMock('en'));
        await flush();
        await expect(translationManager.loadTranslations('en')).resolves.toEqual(english);
        await expect(translationManager.loadTranslations('en')).resolves.toEqual(english);
    });

    test('a table that fails to load is logged and yields null', async () => {
        const { translationManager, logger } = load(() => {
            settingsMock('en')();
            jest.doMock('../../src/js/translations/latvian', () => {
                throw new Error('corrupt table');
            });
        });
        await flush();
        const log = withCategoryLog(logger);
        await expect(translationManager.loadTranslations('lv')).resolves.toBeNull();
        expect(log.warning).toHaveBeenCalledWith('Could not load translations for lv: corrupt table', null);
    });

    test('an empty table is returned but not cached', async () => {
        const { translationManager, translations } = load(() => {
            settingsMock('en')();
            jest.doMock('../../src/js/translations/latvian', () => null);
        });
        await flush();
        await expect(translationManager.loadTranslations('lv')).resolves.toBeNull();
        expect(translations.lv).toBeUndefined();
    });
});

describe('setLanguage / saveLanguageToSettings', () => {
    test('a supported language is persisted through the settings facade and applied', async () => {
        let settings;
        const { translationManager } = load(() => {
            settingsMock('en')();
            settings = require(SETTINGS);
        });
        await flush();
        await expect(translationManager.setLanguage('lv')).resolves.toBe(true);
        expect(settings.setSetting).toHaveBeenCalledWith('language', 'lv');
        expect(translationManager.getCurrentLanguage()).toBe('lv');
    });

    test('an unsupported language is refused', async () => {
        const { translationManager } = load(settingsMock('en'));
        await flush();
        await expect(translationManager.setLanguage('de')).resolves.toBe(false);
        expect(translationManager.getCurrentLanguage()).toBe('en');
    });

    test('a failing settings write is logged and the language is not switched', async () => {
        const { translationManager, logger } = load(
            settingsMock('en', {
                setSetting: jest.fn(() => {
                    throw new Error('read-only');
                }),
            }),
        );
        await flush();
        const log = withCategoryLog(logger);
        await translationManager.saveLanguageToSettings('lv');
        expect(log.error).toHaveBeenCalledWith('Could not save language to settings (Node.js):', expect.any(Error));
        expect(translationManager.getCurrentLanguage()).toBe('en');
    });

    test('lists the available languages', () => {
        const { translationManager } = load(settingsMock('en'));
        expect(translationManager.getAvailableLanguages()).toEqual(['en', 'lv']);
    });
});

describe('t()', () => {
    test('resolves a nested key, or a whole section', async () => {
        const { translationManager } = load(settingsMock('en'));
        await flush();
        expect(translationManager.t('common.light')).toBe(english.common.light);
        expect(translationManager.t('common')).toEqual(english.common);
    });

    test('translates in an explicitly requested language without switching', async () => {
        const { translationManager } = load(settingsMock('en'));
        await flush();
        await translationManager.loadTranslations('lv');
        expect(translationManager.t('common.light', 'lv')).toBe(latvian.common.light);
        expect(translationManager.getCurrentLanguage()).toBe('en');
        expect(translationManager.t('common.light')).toBe(english.common.light);
    });

    test('a key missing in the current language falls back to English', async () => {
        const { translationManager, translations } = load(settingsMock('lv'));
        await flush();
        await translationManager.loadTranslations('en');
        translations.lv = { common: {} };
        expect(translationManager.t('common.dark')).toBe(english.common.dark);
    });

    test('a key missing in English too returns the key itself', async () => {
        const { translationManager } = load(settingsMock('lv'));
        await flush();
        await translationManager.loadTranslations('en');
        expect(translationManager.t('common.noSuchKey')).toBe('common.noSuchKey');
        expect(translationManager.t('nope.at.all')).toBe('nope.at.all');
    });

    test('a leaf reached early does not swallow the rest of the key', async () => {
        const { translationManager } = load(settingsMock('en'));
        await flush();
        expect(translationManager.t('common.dark.extra')).toBe('common.dark.extra');
    });

    test('with English not loaded, a miss in another language logs the fallback and returns the key', async () => {
        const { translationManager, logger } = load(settingsMock('lv'));
        await flush();
        const log = withCategoryLog(logger);
        expect(translationManager.t('common.noSuchKey')).toBe('common.noSuchKey');
        expect(log.warning).toHaveBeenCalledWith('Fallback to English for key: common.noSuchKey', null);
    });

    test('in English with nothing loaded, a miss returns the key', async () => {
        const { translationManager, translations } = load(settingsMock('en'));
        await flush();
        delete translations.en;
        expect(translationManager.t('common.dark')).toBe('common.dark');
    });
});

describe('UMD root selection', () => {
    afterEach(() => {
        delete globalThis.self;
    });

    test.each([
        ['english', english],
        ['latvian', latvian],
    ])('%s still exports through CommonJS when a `self` global exists', (name, table) => {
        globalThis.self = {};
        jest.resetModules();
        const loaded = require(`../../src/js/translations/${name}`);
        expect(loaded).toEqual(table);
        expect(globalThis.self).toEqual({});
    });

    test('index still exports through CommonJS when a `self` global exists', async () => {
        globalThis.self = {};
        const { translationManager } = load(settingsMock('en'));
        await flush();
        expect(translationManager.getCurrentLanguage()).toBe('en');
        expect(globalThis.self).toEqual({});
    });
});
