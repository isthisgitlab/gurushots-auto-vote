/**
 * @jest-environment @happy-dom/jest-environment
 */

/**
 * translations/index.js in a renderer (Electron window): the language comes
 * from the preload bridge (window.api), tables are pulled in as <script> tags,
 * and diagnostics route through window.api.logDebug — or console.warn before
 * the bridge attaches (the raw <script> context has no logger). The Node paths
 * live in translationManager.node.test.js.
 */

const SETTINGS = '../../src/js/settings';
const LOGGER = '../../src/js/logger';
const INDEX = '../../src/js/translations/index';
const english = require('../../src/js/translations/english');
const latvian = require('../../src/js/translations/latvian');

const TABLES = { 'english.js': ['englishTranslations', english], 'latvian.js': ['latvianTranslations', latvian] };

/** How the stubbed <script> load behaves: 'load' (sets the global), 'empty' (loads, sets nothing) or 'error'. */
let scriptMode;
let appended;

const load = (setup = () => {}) => {
    jest.resetModules();
    setup();
    const logger = require(LOGGER);
    return { ...require(INDEX), logger };
};

/** Let init()'s awaits (bridge calls, script loads) settle. */
const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const bridge = (overrides = {}) => ({
    getSettings: jest.fn(async () => ({ language: 'en' })),
    setSetting: jest.fn(async () => {}),
    logDebug: jest.fn(),
    ...overrides,
});

let warnSpy;
beforeEach(() => {
    scriptMode = 'load';
    appended = [];
    delete window.api;
    delete window.englishTranslations;
    delete window.latvianTranslations;
    jest.spyOn(document.head, 'appendChild').mockImplementation((el) => {
        appended.push(el.getAttribute('src'));
        const file = el.getAttribute('src').split('/').pop();
        if (scriptMode === 'error') {
            el.onerror(new Error(`failed to load ${file}`));
        } else {
            if (scriptMode === 'load') window[TABLES[file][0]] = TABLES[file][1];
            el.onload();
        }
        return el;
    });
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    jest.dontMock(SETTINGS);
});

describe('startup through the preload bridge', () => {
    test('reads the saved language and pulls its table in as a <script>', async () => {
        window.api = bridge({ getSettings: jest.fn(async () => ({ language: 'lv' })) });
        const { translationManager, translations } = load();
        await flush();
        expect(appended).toEqual(['../js/translations/latvian.js']);
        expect(translationManager.initialized).toBe(true);
        expect(translationManager.getCurrentLanguage()).toBe('lv');
        expect(translations.lv).toBe(latvian);
        expect(translationManager.t('common.dark')).toBe(latvian.common.dark);
    });

    test('English is loaded as a script too', async () => {
        window.api = bridge();
        const { translationManager } = load();
        await flush();
        expect(appended).toEqual(['../js/translations/english.js']);
        expect(translationManager.t('common.light')).toBe(english.common.light);
    });

    test('a table already on the page is not loaded again', async () => {
        window.api = bridge();
        window.englishTranslations = english;
        const { translationManager } = load();
        await flush();
        expect(appended).toEqual([]);
        expect(translationManager.t('common.light')).toBe(english.common.light);
    });

    test('a failing bridge read is logged and leaves the default language', async () => {
        window.api = bridge({ getSettings: jest.fn().mockRejectedValue(new Error('ipc down')) });
        const { translationManager, logger } = load();
        const log = { warning: jest.fn() };
        logger.withCategory.mockReturnValue(log);
        await flush();
        expect(log.warning).toHaveBeenCalledWith('Could not load language from settings:', expect.any(Error));
        expect(translationManager.getCurrentLanguage()).toBe('en');
    });

    test('a bridge without getSettings falls back to the settings facade', async () => {
        window.api = { logDebug: jest.fn() };
        const { translationManager } = load(() =>
            jest.doMock(SETTINGS, () => ({ getSetting: jest.fn(() => 'lv'), setSetting: jest.fn() })),
        );
        await flush();
        expect(translationManager.getCurrentLanguage()).toBe('lv');
    });
});

describe('waiting for the bridge', () => {
    test('polls until window.api attaches, then loads from it', async () => {
        jest.useFakeTimers();
        const { translationManager } = load();
        await jest.advanceTimersByTimeAsync(300);
        expect(translationManager.initialized).toBe(false);
        window.api = bridge({ getSettings: jest.fn(async () => ({ language: 'lv' })) });
        await jest.advanceTimersByTimeAsync(100);
        expect(translationManager.initialized).toBe(true);
        expect(translationManager.getCurrentLanguage()).toBe('lv');
    });

    test('gives up after 50 attempts and falls back to the settings facade', async () => {
        jest.useFakeTimers();
        const { translationManager } = load(() =>
            jest.doMock(SETTINGS, () => ({ getSetting: jest.fn(() => 'en'), setSetting: jest.fn() })),
        );
        await jest.advanceTimersByTimeAsync(4900);
        expect(translationManager.initialized).toBe(false);
        await jest.advanceTimersByTimeAsync(100);
        expect(translationManager.initialized).toBe(true);
        expect(translationManager.getCurrentLanguage()).toBe('en');
    });
});

describe('table load failures', () => {
    test('with the bridge up, a failed script load goes to logDebug and yields null', async () => {
        window.api = bridge();
        const { translationManager } = load();
        await flush();
        scriptMode = 'error';
        await expect(translationManager.loadTranslations('lv')).resolves.toBeNull();
        expect(window.api.logDebug).toHaveBeenCalledWith(
            'Could not load translations for lv: failed to load latvian.js',
        );
    });

    test.each([
        ['no bridge yet', undefined],
        ['a bridge without logDebug', {}],
    ])('with %s, a failed script load falls back to console.warn', async (_label, api) => {
        window.api = bridge();
        const { translationManager } = load();
        await flush();
        window.api = api;
        scriptMode = 'error';
        await expect(translationManager.loadTranslations('lv')).resolves.toBeNull();
        expect(warnSpy).toHaveBeenCalledWith('Could not load translations for lv:', expect.any(Error));
    });

    test('a script that loads but defines no table is returned as-is and not cached', async () => {
        window.api = bridge();
        const { translationManager, translations } = load();
        await flush();
        scriptMode = 'empty';
        await expect(translationManager.loadTranslations('lv')).resolves.toBeUndefined();
        expect(translations.lv).toBeUndefined();
    });
});

describe('saving the language', () => {
    test('persists through the bridge and switches', async () => {
        window.api = bridge();
        const { translationManager } = load();
        await flush();
        await expect(translationManager.setLanguage('lv')).resolves.toBe(true);
        expect(window.api.setSetting).toHaveBeenCalledWith('language', 'lv');
        expect(translationManager.getCurrentLanguage()).toBe('lv');
    });

    test('a failing bridge write is logged and the language stays', async () => {
        window.api = bridge({ setSetting: jest.fn().mockRejectedValue(new Error('ipc down')) });
        const { translationManager, logger } = load();
        await flush();
        const log = { error: jest.fn() };
        logger.withCategory.mockReturnValue(log);
        await translationManager.saveLanguageToSettings('lv');
        expect(log.error).toHaveBeenCalledWith('Could not save language to settings:', expect.any(Error));
        expect(translationManager.getCurrentLanguage()).toBe('en');
    });

    test('a bridge without setSetting falls back to the settings facade', async () => {
        let settings;
        window.api = { getSettings: jest.fn(async () => ({ language: 'en' })) };
        const { translationManager } = load(() => {
            jest.doMock(SETTINGS, () => ({ getSetting: jest.fn(), setSetting: jest.fn() }));
            settings = require(SETTINGS);
        });
        await flush();
        await translationManager.saveLanguageToSettings('lv');
        expect(settings.setSetting).toHaveBeenCalledWith('language', 'lv');
        expect(translationManager.getCurrentLanguage()).toBe('lv');
    });
});

describe('t() fallback diagnostics', () => {
    test('with the bridge up, a miss with English unloaded goes to logDebug', async () => {
        window.api = bridge({ getSettings: jest.fn(async () => ({ language: 'lv' })) });
        const { translationManager } = load();
        await flush();
        expect(translationManager.t('common.noSuchKey')).toBe('common.noSuchKey');
        expect(window.api.logDebug).toHaveBeenCalledWith('Fallback to English for key: common.noSuchKey');
    });

    test('without the bridge, it goes to console.warn', async () => {
        window.api = bridge({ getSettings: jest.fn(async () => ({ language: 'lv' })) });
        const { translationManager } = load();
        await flush();
        delete window.api;
        expect(translationManager.t('common.noSuchKey')).toBe('common.noSuchKey');
        expect(warnSpy).toHaveBeenCalledWith('Fallback to English for key: common.noSuchKey');
    });
});

describe('UMD root selection', () => {
    test('with no `self`, the factory still loads under CommonJS against `window`', async () => {
        const original = Object.getOwnPropertyDescriptor(globalThis, 'self');
        Object.defineProperty(globalThis, 'self', { value: undefined, configurable: true, writable: true });
        try {
            window.api = bridge();
            const { translationManager } = load();
            jest.resetModules();
            expect(require('../../src/js/translations/english')).toEqual(english);
            expect(require('../../src/js/translations/latvian')).toEqual(latvian);
            await flush();
            expect(translationManager.getCurrentLanguage()).toBe('en');
        } finally {
            if (original) Object.defineProperty(globalThis, 'self', original);
            else delete globalThis.self;
        }
    });
});
