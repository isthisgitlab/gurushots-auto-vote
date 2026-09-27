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

import { isPlainObject } from '../plainObject';
import * as english from './english';
import * as latvian from './latvian';

const TABLES: Record<string, object> = { en: english, lv: latvian };
const DEFAULT_LANGUAGE = 'en';

const isSupportedLanguage = (language: unknown): language is string =>
    typeof language === 'string' && Object.keys(TABLES).includes(language);

/**
 * A supported language code as-is, anything else (null, unknown code) as the
 * default language.
 */
const resolveLanguage = (language: unknown): string => (isSupportedLanguage(language) ? language : DEFAULT_LANGUAGE);

/**
 * Walk a dotted key through a table. Empty strings count as missing so they
 * fall back like an absent key.
 *
 * @returns the value, or undefined when any segment is missing
 */
function lookup(table: unknown, keys: string[]): unknown {
    let value = table;
    for (const k of keys) {
        if (!isPlainObject(value) || !value[k]) return undefined;
        value = value[k];
    }
    return value;
}

/**
 * Translate a dotted key in `language`, falling back to English and then to
 * the key itself. No interpolation — callers substitute placeholders.
 */
function translate(key: string, language: string | undefined): string {
    const keys = key.split('.');
    const found = lookup(TABLES[resolveLanguage(language)], keys) ?? lookup(TABLES[DEFAULT_LANGUAGE], keys);
    return typeof found === 'string' ? found : key;
}

/**
 * A translator holding its own current language (default English).
 */
function createTranslator(): {
    t: (key: string, language?: string) => string;
    getCurrentLanguage: () => string;
    setCurrentLanguage: (language: unknown) => void;
} {
    let currentLanguage = DEFAULT_LANGUAGE;
    return {
        t: (key, language = currentLanguage) => translate(key, language),
        getCurrentLanguage: () => currentLanguage,
        setCurrentLanguage: (language) => {
            currentLanguage = resolveLanguage(language);
        },
    };
}

export { DEFAULT_LANGUAGE, createTranslator, isSupportedLanguage, resolveLanguage };
