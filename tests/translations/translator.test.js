/**
 * translations/translator.js — the dependency-free translator core — and the
 * renderer's shared instance (translations/renderer.js).
 */

const english = require('../../src/js/translations/english');
const latvian = require('../../src/js/translations/latvian');
const {
    DEFAULT_LANGUAGE,
    createTranslator,
    isSupportedLanguage,
    resolveLanguage,
} = require('../../src/js/translations/translator');

describe('language helpers', () => {
    test('only en and lv are supported', () => {
        expect(isSupportedLanguage('en')).toBe(true);
        expect(isSupportedLanguage('lv')).toBe(true);
        expect(isSupportedLanguage('de')).toBe(false);
        expect(isSupportedLanguage('constructor')).toBe(false);
        expect(isSupportedLanguage(null)).toBe(false);
    });

    test('resolveLanguage keeps a supported code and defaults anything else to English', () => {
        expect(DEFAULT_LANGUAGE).toBe('en');
        expect(resolveLanguage('lv')).toBe('lv');
        expect(resolveLanguage('de')).toBe('en');
        expect(resolveLanguage(undefined)).toBe('en');
    });
});

describe('createTranslator', () => {
    let translator;
    beforeEach(() => {
        translator = createTranslator();
    });

    test('starts in English', () => {
        expect(translator.getCurrentLanguage()).toBe('en');
        expect(translator.t('common.dark')).toBe(english.common.dark);
    });

    test('setCurrentLanguage switches the default language of t()', () => {
        translator.setCurrentLanguage('lv');
        expect(translator.getCurrentLanguage()).toBe('lv');
        expect(translator.t('common.dark')).toBe(latvian.common.dark);
    });

    test('setCurrentLanguage resolves an unsupported language to English', () => {
        translator.setCurrentLanguage('lv');
        translator.setCurrentLanguage('de');
        expect(translator.getCurrentLanguage()).toBe('en');
    });

    test('an explicit language overrides the current one', () => {
        expect(translator.t('logs.title', 'lv')).toBe(latvian.logs.title);
        translator.setCurrentLanguage('lv');
        expect(translator.t('logs.title', 'en')).toBe(english.logs.title);
    });

    test('an unknown language translates in English', () => {
        expect(translator.t('logs.title', 'de')).toBe(english.logs.title);
    });

    test('a nested key resolves to the subtree', () => {
        expect(translator.t('logs')).toBe(english.logs);
    });

    test('a missing key returns the key itself', () => {
        expect(translator.t('logs.nope')).toBe('logs.nope');
        expect(translator.t('nope.deeper.still', 'lv')).toBe('nope.deeper.still');
        expect(translator.t('logs.title.extra')).toBe('logs.title.extra');
    });

    test('translators hold independent languages', () => {
        const other = createTranslator();
        translator.setCurrentLanguage('lv');
        expect(other.getCurrentLanguage()).toBe('en');
    });
});

describe('English fallback', () => {
    afterEach(() => {
        jest.dontMock('../../src/js/translations/latvian');
    });

    test('a key missing (or empty) in Latvian falls back to English', () => {
        jest.isolateModules(() => {
            jest.doMock('../../src/js/translations/latvian', () => ({ logs: { title: '' }, common: {} }));
            const { createTranslator: isolated } = require('../../src/js/translations/translator');
            const translator = isolated();
            expect(translator.t('logs.title', 'lv')).toBe(english.logs.title);
            expect(translator.t('common.dark', 'lv')).toBe(english.common.dark);
            expect(translator.t('app.title', 'lv')).toBe(english.app.title);
        });
    });
});

describe('renderer instance', () => {
    test('is a translator shared by every importer of the module', () => {
        const { rendererTranslator } = require('../../src/js/translations/renderer');
        expect(require('../../src/js/translations/renderer').rendererTranslator).toBe(rendererTranslator);
        expect(rendererTranslator.getCurrentLanguage()).toBe('en');
        expect(rendererTranslator.t('common.dark', 'lv')).toBe(latvian.common.dark);
    });
});
