/**
 * Translator core shared by every platform: the language tables, the key
 * lookup behind `t()`, and a per-context "current language".
 *
 * Deliberately dependency-free (no settings, logger or electron requires):
 * the renderer bundles import it, and pulling the settings facade in would
 * drag zod into every page bundle. Persisting the chosen language is the job
 * of the platform adapters — translations/index.ts (Node: settings facade)
 * and react/contexts/TranslationContext.tsx (renderer: window.api).
 */

import { isPlainObject } from '../plainObject';
import * as english from './english';
import * as latvian from './latvian';

const TABLES: Record<string, object> = { en: english, lv: latvian };
const DEFAULT_LANGUAGE = 'en';

/** The values a call site may pass for the `{name}` placeholders. */
type TranslateVars = Record<string, string | number | null | undefined>;

/** What a host hands to its UI: key + variables; the language stays inside the translator. */
type Translate = (key: string, vars?: TranslateVars) => string;

const isSupportedLanguage = (language: unknown): language is string =>
    typeof language === 'string' && Object.keys(TABLES).includes(language);

/**
 * A supported language code as-is, anything else (null, unknown code) as the
 * default language.
 */
const resolveLanguage = (language: unknown): string => (isSupportedLanguage(language) ? language : DEFAULT_LANGUAGE);

// One selector/formatter per resolved language, so each cache only ever holds en and lv.
const pluralRulesCache = new Map<string, Intl.PluralRules>();
const numberFormatCache = new Map<string, Intl.NumberFormat>();

const getPluralRules = (language: string): Intl.PluralRules => {
    let rules = pluralRulesCache.get(language);
    if (!rules) {
        rules = new Intl.PluralRules(language);
        pluralRulesCache.set(language, rules);
    }
    return rules;
};

const formatCount = (value: number, language: string): string => {
    let format = numberFormatCache.get(language);
    if (!format) {
        format = new Intl.NumberFormat(language);
        numberFormatCache.set(language, format);
    }
    return format.format(value);
};

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
 * The plural chain for one key in one language: `<key>_<category>` for the
 * count's CLDR category, then `<key>_other`, then the plain key. A missing or
 * non-number count skips the category step, so it reaches `_other` and never
 * shows a raw key; on plain keys the suffixed steps simply miss.
 */
function lookupPlural(table: unknown, keys: string[], language: string, count: TranslateVars['count']): unknown {
    const base = keys[keys.length - 1];
    const parent = keys.slice(0, -1);
    if (typeof count === 'number') {
        const categorized = lookup(table, [...parent, `${base}_${getPluralRules(language).select(count)}`]);
        if (categorized !== undefined) return categorized;
    }
    return lookup(table, [...parent, `${base}_other`]) ?? lookup(table, keys);
}

/**
 * Fill `{name}` placeholders in a single pass, so a value containing `{other}`
 * or `$&` is never expanded. A token whose var is missing, null or not an own
 * property renders as an empty string; a numeric `count` keeps its thousands
 * grouping in the reader's language.
 */
function interpolate(template: string, language: string, vars: TranslateVars): string {
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
        if (!Object.hasOwn(vars, name)) return '';
        const value = vars[name];
        if (value === null || value === undefined) return '';
        return name === 'count' && typeof value === 'number' ? formatCount(value, language) : String(value);
    });
}

/**
 * Translate a dotted key in `language`, falling back to English and then to
 * the key itself. Each language runs the full plural chain with its own CLDR
 * rules. A found string is interpolated only when `vars` is provided; a miss
 * returns the key itself, uninterpolated.
 */
function translate(key: string, language: string | undefined, vars?: TranslateVars): string {
    const resolved = resolveLanguage(language);
    const keys = key.split('.');
    const found =
        lookupPlural(TABLES[resolved], keys, resolved, vars?.count) ??
        lookupPlural(TABLES[DEFAULT_LANGUAGE], keys, DEFAULT_LANGUAGE, vars?.count);
    if (typeof found !== 'string') return key;
    return vars === undefined ? found : interpolate(found, resolved, vars);
}

/**
 * A translator holding its own current language (default English).
 */
function createTranslator(): {
    t: (key: string, vars?: TranslateVars, language?: string) => string;
    getCurrentLanguage: () => string;
    setCurrentLanguage: (language: unknown) => void;
} {
    let currentLanguage = DEFAULT_LANGUAGE;
    return {
        t: (key, vars, language = currentLanguage) => translate(key, language, vars),
        getCurrentLanguage: () => currentLanguage,
        setCurrentLanguage: (language) => {
            currentLanguage = resolveLanguage(language);
        },
    };
}

export { DEFAULT_LANGUAGE, createTranslator, isSupportedLanguage, resolveLanguage };
export type { Translate, TranslateVars };
