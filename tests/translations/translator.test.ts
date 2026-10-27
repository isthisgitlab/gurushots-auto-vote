/**
 * translations/translator.ts — the dependency-free translator core — and the
 * renderer's shared instance (translations/renderer.ts).
 */

import english = require('../../src/ts/translations/english');
import latvian = require('../../src/ts/translations/latvian');
import type * as translatorModule from '../../src/ts/translations/translator';
import type * as rendererModule from '../../src/ts/translations/renderer';
import type { TranslateVars } from '../../src/ts/translations/translator';
import { invalid } from '../helpers/invalid';
const { DEFAULT_LANGUAGE, createTranslator, isSupportedLanguage, resolveLanguage } =
    require('../../src/ts/translations/translator') as typeof translatorModule;

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
    let translator: ReturnType<typeof createTranslator>;
    beforeEach(() => {
        translator = createTranslator();
    });

    test('starts in English', () => {
        expect(translator.getCurrentLanguage()).toBe('en');
        expect(translator.t('themes.dark')).toBe(english.themes.dark);
    });

    test('setCurrentLanguage switches the default language of t()', () => {
        translator.setCurrentLanguage('lv');
        expect(translator.getCurrentLanguage()).toBe('lv');
        expect(translator.t('themes.dark')).toBe(latvian.themes.dark);
    });

    test('setCurrentLanguage resolves an unsupported language to English', () => {
        translator.setCurrentLanguage('lv');
        translator.setCurrentLanguage('de');
        expect(translator.getCurrentLanguage()).toBe('en');
    });

    test('an explicit language overrides the current one', () => {
        expect(translator.t('logs.title', undefined, 'lv')).toBe(latvian.logs.title);
        translator.setCurrentLanguage('lv');
        expect(translator.t('logs.title', undefined, 'en')).toBe(english.logs.title);
    });

    test('an unknown language translates in English', () => {
        expect(translator.t('logs.title', undefined, 'de')).toBe(english.logs.title);
    });

    test('a key naming a group of strings, not one string, returns the key itself', () => {
        expect(translator.t('logs')).toBe('logs');
    });

    test('a missing key returns the key itself', () => {
        expect(translator.t('logs.nope')).toBe('logs.nope');
        expect(translator.t('nope.deeper.still', undefined, 'lv')).toBe('nope.deeper.still');
        expect(translator.t('logs.title.extra')).toBe('logs.title.extra');
    });

    test('translators hold independent languages', () => {
        const other = createTranslator();
        translator.setCurrentLanguage('lv');
        expect(other.getCurrentLanguage()).toBe('en');
    });
});

describe('interpolation', () => {
    let translator: ReturnType<typeof createTranslator>;
    beforeEach(() => {
        translator = createTranslator();
    });

    test('without vars the found string is returned unchanged, placeholders intact', () => {
        expect(translator.t('app.photoChooserShowing')).toBe('Showing {count} photos.');
        expect(translator.t('app.benchmarkScore')).toBe('Top {target}: {count} votes');
    });

    test('a token whose var is missing renders as an empty string', () => {
        expect(translator.t('app.benchmarkScore', { count: 2 }, 'en')).toBe('Top : 2 votes');
    });

    test('a null or undefined var renders as an empty string', () => {
        expect(translator.t('app.benchmarkScore', { target: null, count: 2 }, 'en')).toBe('Top : 2 votes');
        expect(translator.t('app.benchmarkScore', { target: undefined, count: 1 }, 'en')).toBe('Top : 1 vote');
    });

    test('a token that is not an own property of vars renders as an empty string', () => {
        const inherited = invalid<TranslateVars>(Object.create({ count: 5 }));
        expect(translator.t('app.photoChooserShowing', inherited, 'en')).toBe('Showing  photos.');
    });

    test('a value containing $& is never expanded by the replacer', () => {
        expect(translator.t('app.photoChooserShowing', { count: '$&' }, 'en')).toBe('Showing $& photos.');
    });

    test('a value containing {other} braces is never re-interpolated (single pass)', () => {
        expect(translator.t('app.photoChooserShowing', { count: '{b}', b: 'x' }, 'en')).toBe('Showing {b} photos.');
    });

    test('a numeric count keeps its thousands grouping in the reader’s language', () => {
        expect(translator.t('app.photoChooserShowing', { count: 1000 }, 'en')).toBe('Showing 1,000 photos.');
        expect(translator.t('app.photoChooserShowing', { count: 1000 }, 'lv')).toBe(
            `Rāda ${new Intl.NumberFormat('lv').format(1000)} foto.`,
        );
    });

    test('the current language formats a numeric count when no explicit language is given', () => {
        translator.setCurrentLanguage('lv');
        expect(translator.t('app.photoChooserShowing', { count: 1000 })).toBe(
            `Rāda ${new Intl.NumberFormat('lv').format(1000)} foto.`,
        );
    });

    test('a numeric value of any other token goes through String() without grouping', () => {
        expect(translator.t('app.benchmarkScore', { target: 1000, count: 2 }, 'en')).toBe('Top 1000: 2 votes');
    });

    test('a string value goes through String()', () => {
        expect(translator.t('app.photoChooserShowing', { count: '5' }, 'en')).toBe('Showing 5 photos.');
    });

    test('a miss returns the key itself, uninterpolated', () => {
        expect(translator.t('nope.deeper', { count: 5 })).toBe('nope.deeper');
    });
});

describe('plurals', () => {
    let translator: ReturnType<typeof createTranslator>;
    beforeEach(() => {
        translator = createTranslator();
    });

    test('the lv selector resolves Latvian categories', () => {
        expect(new Intl.PluralRules('lv').resolvedOptions().locale.startsWith('lv')).toBe(true);
    });

    test.each([
        [0, '+0 balsis virs rezervista'],
        [1, '+1 balss virs rezervista'],
        [11, '+11 balsis virs rezervista'],
        [21, '+21 balss virs rezervista'],
        [22, '+22 balsis virs rezervista'],
    ])('lv selects count %i', (count, expected) => {
        expect(translator.t('app.teamStandingOverStandby', { count }, 'lv')).toBe(expected);
    });

    test('en selects 1 and 2', () => {
        expect(translator.t('app.teamStandingOverStandby', { count: 1 }, 'en')).toBe('+1 vote over standby');
        expect(translator.t('app.teamStandingOverStandby', { count: 2 }, 'en')).toBe('+2 votes over standby');
    });

    test('an lv group with only _other never shows English', () => {
        expect(translator.t('app.photoChooserShowing', { count: 21 }, 'lv')).toBe('Rāda 21 foto.');
        expect(translator.t('app.photoChooserShowing', { count: 0 }, 'lv')).toBe('Rāda 0 foto.');
    });

    test('a missing or non-number count reaches _other, never a raw key', () => {
        expect(translator.t('app.teamStandingOverStandby', {}, 'en')).toBe('+ votes over standby');
        expect(translator.t('app.teamStandingOverStandby', { count: '5' }, 'en')).toBe('+5 votes over standby');
    });

    test('the plural chain simply misses on a plain key', () => {
        expect(translator.t('themes.dark', { count: 2 })).toBe(english.themes.dark);
    });
});

describe('English fallback', () => {
    afterEach(() => {
        jest.dontMock('../../src/ts/translations/latvian');
    });

    test('a key missing (or empty) in Latvian falls back to English', () => {
        jest.isolateModules(() => {
            jest.doMock('../../src/ts/translations/latvian', () => ({ logs: { title: '' }, common: {} }));
            const { createTranslator: isolated } =
                require('../../src/ts/translations/translator') as typeof translatorModule;
            const translator = isolated();
            expect(translator.t('logs.title', undefined, 'lv')).toBe(english.logs.title);
            expect(translator.t('themes.dark', undefined, 'lv')).toBe(english.themes.dark);
            expect(translator.t('app.title', undefined, 'lv')).toBe(english.app.title);
        });
    });

    test('a group missing in Latvian falls back to English with English rules', () => {
        jest.isolateModules(() => {
            jest.doMock('../../src/ts/translations/latvian', () => ({ logs: { title: '' }, common: {}, app: {} }));
            const { createTranslator: isolated } =
                require('../../src/ts/translations/translator') as typeof translatorModule;
            const translator = isolated();
            expect(translator.t('app.teamStandingOverStandby', { count: 1 }, 'lv')).toBe('+1 vote over standby');
            // 21 is en-other but lv-one: English rules, not Latvian ones, must pick the form.
            expect(translator.t('app.teamStandingOverStandby', { count: 21 }, 'lv')).toBe('+21 votes over standby');
        });
    });
});

describe('renderer instance', () => {
    test('is a translator shared by every importer of the module', () => {
        const { rendererTranslator } = require('../../src/ts/translations/renderer') as typeof rendererModule;
        expect(
            (require('../../src/ts/translations/renderer') as typeof import('../../src/ts/translations/renderer'))
                .rendererTranslator,
        ).toBe(rendererTranslator);
        expect(rendererTranslator.getCurrentLanguage()).toBe('en');
        expect(rendererTranslator.t('themes.dark', undefined, 'lv')).toBe(latvian.themes.dark);
    });
});
