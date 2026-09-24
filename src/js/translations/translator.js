// @ts-check
/**
 * Translator core shared by every platform: the language tables, the key
 * lookup behind `t()`, and a per-context "current language".
 *
 * Deliberately dependency-free (no settings, logger or electron requires):
 * the renderer bundles import it, and pulling the settings facade in would
 * drag zod into every page bundle. Persisting the chosen language is the job
 * of the platform adapters — translations/index.js (Node: settings facade)
 * and react/contexts/TranslationContext.jsx (renderer: window.api).
 */

const english = require('./english');
const latvian = require('./latvian');

/** @type {Record<string, object>} */
const TABLES = { en: english, lv: latvian };
const DEFAULT_LANGUAGE = 'en';

/**
 * @param {unknown} language
 * @returns {language is string}
 */
const isSupportedLanguage = (language) => typeof language === 'string' && Object.keys(TABLES).includes(language);

/**
 * A supported language code as-is, anything else (null, unknown code) as the
 * default language.
 *
 * @param {unknown} language
 * @returns {string}
 */
const resolveLanguage = (language) => (isSupportedLanguage(language) ? language : DEFAULT_LANGUAGE);

/**
 * Walk a dotted key through a table. Empty strings count as missing so they
 * fall back like an absent key.
 *
 * @param {any} table
 * @param {string[]} keys
 * @returns {any} the value, or undefined when any segment is missing
 */
function lookup(table, keys) {
    let value = table;
    for (const k of keys) {
        if (!value?.[k]) return undefined;
        value = value[k];
    }
    return value;
}

/**
 * Translate a dotted key in `language`, falling back to English and then to
 * the key itself. No interpolation — callers substitute placeholders.
 *
 * @param {string} key
 * @param {unknown} language
 * @returns {any}
 */
function translate(key, language) {
    const keys = key.split('.');
    return lookup(TABLES[resolveLanguage(language)], keys) ?? lookup(TABLES[DEFAULT_LANGUAGE], keys) ?? key;
}

/**
 * A translator holding its own current language (default English).
 *
 * @returns {{
 *   t: (key: string, language?: string) => any,
 *   getCurrentLanguage: () => string,
 *   setCurrentLanguage: (language: unknown) => void,
 * }}
 */
function createTranslator() {
    let currentLanguage = DEFAULT_LANGUAGE;
    return {
        t: (key, language = currentLanguage) => translate(key, language),
        getCurrentLanguage: () => currentLanguage,
        setCurrentLanguage: (language) => {
            currentLanguage = resolveLanguage(language);
        },
    };
}

module.exports = { DEFAULT_LANGUAGE, createTranslator, isSupportedLanguage, resolveLanguage };
