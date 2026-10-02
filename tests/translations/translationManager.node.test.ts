/**
 * translations/index.ts — the Node translation manager (Electron main): the
 * translator core plus the language read from the settings facade.
 */

import english = require('../../src/ts/translations/english');
import latvian = require('../../src/ts/translations/latvian');
import { invalid } from '../helpers/invalid';

const SETTINGS = '../../src/ts/settings';
const LOGGER = '../../src/ts/logger';
const INDEX = '../../src/ts/translations/index';

/** Fresh module instance (the manager is module-level and reads settings on load). */
const load = (getSetting: () => unknown) => {
    jest.resetModules();
    jest.doMock(SETTINGS, () => ({ getSetting: jest.fn(getSetting) }));
    const logger = jest.mocked(require(LOGGER) as typeof import('../../src/ts/logger'));
    const log = { warning: jest.fn() };
    logger.withCategory.mockReturnValue(invalid(log));
    return {
        ...(require(INDEX) as typeof import('../../src/ts/translations/index')),
        settings: jest.mocked(require(SETTINGS) as typeof import('../../src/ts/settings')),
        logger,
        log,
    };
};

afterEach(() => {
    jest.dontMock(SETTINGS);
});

describe('startup', () => {
    test('adopts the saved language from the settings facade on load', () => {
        const { translationManager, settings } = load(() => 'lv');
        expect(settings.getSetting).toHaveBeenCalledWith('language');
        expect(translationManager.getCurrentLanguage()).toBe('lv');
        expect(translationManager.t('themes.dark')).toBe(latvian.themes.dark);
    });

    test('an unset or unknown saved language falls back to English', () => {
        const { translationManager } = load(() => undefined);
        expect(translationManager.getCurrentLanguage()).toBe('en');
        expect(translationManager.t('themes.dark')).toBe(english.themes.dark);
    });

    test('a settings failure is logged and English stays active', () => {
        const error = new Error('disk');
        const { translationManager, logger, log } = load(() => {
            throw error;
        });
        expect(logger.withCategory).toHaveBeenCalledWith('translation');
        expect(log.warning).toHaveBeenCalledWith('Could not load language from settings:', error);
        expect(translationManager.getCurrentLanguage()).toBe('en');
    });
});

describe('loadLanguageFromSettings', () => {
    test('re-reads the saved language (menu refresh after a language change)', async () => {
        let saved = 'en';
        const { translationManager } = load(() => saved);
        saved = 'lv';
        await translationManager.loadLanguageFromSettings();
        expect(translationManager.getCurrentLanguage()).toBe('lv');
        expect(translationManager.t('logs.title')).toBe(latvian.logs.title);
    });
});
