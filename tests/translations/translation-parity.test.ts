/**
 * Guards the english.ts / latvian.ts key contract: every key must exist in
 * both files, in every section, at every depth. A key missing from latvian.ts
 * does NOT crash at runtime — t() silently falls back to English — so nothing
 * but this test catches the drift.
 */
import english = require('../../src/ts/translations/english');
import latvian = require('../../src/ts/translations/latvian');
import type * as pathModule from 'node:path';
import type * as fsModule from 'node:fs';
import type * as translatorModule from '../../src/ts/translations/translator';
import type { TranslateVars } from '../../src/ts/translations/translator';
import { invalid } from '../helpers/invalid';
const { createTranslator } = require('../../src/ts/translations/translator') as typeof translatorModule;

/** CLDR plural categories, as the `_<category>` key suffixes of a plural group. */
const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const stripPluralSuffix = (key: string): string => key.replace(PLURAL_SUFFIX, '');

/**
 * Flatten a nested translation object into sorted 'section.path.key' strings.
 */
const flattenKeys = (obj: object, prefix: string = ''): string[] => {
    const keys = [];
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            keys.push(...flattenKeys(value, path));
        } else {
            keys.push(path);
        }
    }
    return keys.sort();
};

const englishKeys = flattenKeys(english);
const latvianKeys = flattenKeys(latvian);
const englishKeySet = new Set(englishKeys);
const latvianKeySet = new Set(latvianKeys);

/** A base key belongs to a plural group when a suffixed form exists in either language. */
const pluralGroupBases = [...new Set([...englishKeys, ...latvianKeys].map(stripPluralSuffix))].filter((base) =>
    PLURAL_SUFFIXES.some((s) => englishKeySet.has(`${base}_${s}`) || latvianKeySet.has(`${base}_${s}`)),
);

/** Read one dotted key's string value out of a dictionary (string-ness is guarded elsewhere). */
const valueAt = (table: object, key: string): string => {
    const value = key.split('.').reduce<unknown>((node, part) => invalid<Record<string, unknown>>(node)[part], table);
    if (typeof value !== 'string') throw new Error(`${key} is not a string`);
    return value;
};

describe('translation parity', () => {
    test('english and latvian expose identical key sets', () => {
        const englishBaseKeys = englishKeys.map(stripPluralSuffix);
        const latvianBaseKeys = latvianKeys.map(stripPluralSuffix);

        const missingInLatvian = englishBaseKeys.filter((key) => !latvianBaseKeys.includes(key));
        const missingInEnglish = latvianBaseKeys.filter((key) => !englishBaseKeys.includes(key));

        // Report both directions in one assertion so a failure names the
        // exact drifting keys instead of dumping two full key lists.
        expect({ missingInLatvian, missingInEnglish }).toEqual({ missingInLatvian: [], missingInEnglish: [] });
    });

    test('every translation value is a non-empty string', () => {
        for (const translations of [english, latvian]) {
            for (const key of flattenKeys(translations)) {
                const value = key
                    .split('.')
                    .reduce<unknown>((node, part) => invalid<Record<string, unknown>>(node)[part], translations);
                expect(typeof value).toBe('string');
                expect((value as string).length).toBeGreaterThan(0);
            }
        }
    });
});

describe('plural groups', () => {
    test('every group has _other in both languages and no plain base key', () => {
        const problems = [];
        for (const base of pluralGroupBases) {
            if (!englishKeySet.has(`${base}_other`)) problems.push(`${base}: no _other in english`);
            if (!latvianKeySet.has(`${base}_other`)) problems.push(`${base}: no _other in latvian`);
            if (englishKeySet.has(base)) problems.push(`${base}: plain base key remains in english`);
            if (latvianKeySet.has(base)) problems.push(`${base}: plain base key remains in latvian`);
        }
        expect(problems).toEqual([]);
    });

    test('every used suffix is a plural category of its language, so there is no dead form', () => {
        const categories: Record<'en' | 'lv', Set<string>> = {
            en: new Set(new Intl.PluralRules('en').resolvedOptions().pluralCategories),
            lv: new Set(new Intl.PluralRules('lv').resolvedOptions().pluralCategories),
        };
        const problems = [];
        for (const [keys, language] of [
            [englishKeys, 'en'],
            [latvianKeys, 'lv'],
        ] as const) {
            for (const key of keys) {
                const match = PLURAL_SUFFIX.exec(key);
                if (match && !categories[language].has(match[1])) {
                    problems.push(`${key}: '${match[1]}' is not a ${language} plural category`);
                }
            }
        }
        expect(problems).toEqual([]);
    });
});

describe('every plural group renders every count in both languages', () => {
    const COUNTS = [0, 1, 2, 11, 21, 1000];
    const translator = createTranslator();

    /** The count as a number; every other token gets its own name as a dummy value. */
    const varsFor = (template: string, count: number): TranslateVars => {
        const vars: TranslateVars = {};
        for (const [, name] of template.matchAll(/\{(\w+)\}/g)) {
            vars[name] = name === 'count' ? count : name;
        }
        return vars;
    };

    test.each(pluralGroupBases.map((base) => [base]))('%s', (base) => {
        const failures = [];
        for (const language of ['en', 'lv'] as const) {
            const template = valueAt(language === 'en' ? english : latvian, `${base}_other`);
            for (const count of COUNTS) {
                const result = translator.t(base, varsFor(template, count), language);
                if (result.includes('{') || result.includes(base)) failures.push(`${language} ${count}: ${result}`);
            }
        }
        expect(failures).toEqual([]);
    });
});

describe('renderer translation keys exist', () => {
    // fs is mocked globally in tests/setup.ts; this test reads real sources.
    const fs = jest.requireActual<typeof fsModule>('fs');
    const path = require('node:path') as typeof pathModule;

    // Literal t('section.key') calls only — dynamic keys (t(variable)) can't be
    // checked statically. A missing key renders as the raw key string in the
    // UI (e.g. "common.cancel"), which nothing else catches. A call on a
    // plural group's base key is accepted when a suffixed form exists.
    const listSources = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
            const full = path.join(dir, d.name);
            if (d.isDirectory()) return listSources(full);
            return /\.(jsx?|tsx?|mjs)$/.test(d.name) ? [full] : [];
        });

    test('every literal t() key in src/ts resolves in english.ts', () => {
        const known = new Set(englishKeys);
        const root = path.join(__dirname, '../../src/ts');
        const missing = [];
        for (const file of listSources(root)) {
            const text = fs.readFileSync(file, 'utf8');
            for (const [, key] of text.matchAll(/\bt\(\s*'([a-zA-Z]+\.[a-zA-Z0-9_.]+)'/g)) {
                if (known.has(key)) continue;
                if (PLURAL_SUFFIXES.some((suffix) => known.has(`${key}_${suffix}`))) continue;
                missing.push(`${path.relative(root, file)}: ${key}`);
            }
        }
        expect(missing).toEqual([]);
    });
});

describe('a chip whose accessible name starts with the text it shows (WCAG 2.5.3 label in name)', () => {
    const fill = (template: string) => template.replace('{count}', '3').replace('{title}', 'T');
    test.each([
        ['english', english.app],
        ['latvian', latvian.app],
    ])('%s: the own-list chip', (_language, app) => {
        expect(fill(app.discoverChosenChipLabel).startsWith(fill(app.discoverChosenChip))).toBe(true);
    });
});

describe('the import date sentence ends in one full stop', () => {
    // lv-LV writes a date with its own trailing full stop ("16.10.2026."), so the Latvian sentence must not add another.
    test.each([
        ['en-GB', english.about.importAt],
        ['lv-LV', latvian.about.importAt],
    ])('%s: the sentence after the date ends in a single full stop', (locale, sentence) => {
        const date = new Date('2026-10-16T03:18:00Z').toLocaleDateString(locale);
        const text = sentence.replace('{date}', date);
        expect(text.endsWith('.')).toBe(true);
        expect(text.endsWith('..')).toBe(false);
    });
});
