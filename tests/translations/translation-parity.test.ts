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
import { invalid } from '../helpers/invalid';

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

describe('translation parity', () => {
    test('english and latvian expose identical key sets', () => {
        const englishKeys = flattenKeys(english);
        const latvianKeys = flattenKeys(latvian);

        const missingInLatvian = englishKeys.filter((key) => !latvianKeys.includes(key));
        const missingInEnglish = latvianKeys.filter((key) => !englishKeys.includes(key));

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

describe('renderer translation keys exist', () => {
    // fs is mocked globally in tests/setup.ts; this test reads real sources.
    const fs = jest.requireActual<typeof fsModule>('fs');
    const path = require('node:path') as typeof pathModule;

    // Literal t('section.key') calls only — dynamic keys (t(variable)) can't be
    // checked statically. A missing key renders as the raw key string in the
    // UI (e.g. "common.cancel"), which nothing else catches.
    const listSources = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
            const full = path.join(dir, d.name);
            if (d.isDirectory()) return listSources(full);
            return /\.(jsx?|tsx?|mjs)$/.test(d.name) ? [full] : [];
        });

    test('every literal t() key in src/ts/react resolves in english.ts', () => {
        const known = new Set(flattenKeys(english));
        const root = path.join(__dirname, '../../src/ts/react');
        const missing = [];
        for (const file of listSources(root)) {
            const text = fs.readFileSync(file, 'utf8');
            for (const [, key] of text.matchAll(/\bt\(\s*'([a-zA-Z]+\.[a-zA-Z0-9_.]+)'/g)) {
                if (!known.has(key)) missing.push(`${path.relative(root, file)}: ${key}`);
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
    ])('%s: the own-list and other-account chips', (_language, app) => {
        expect(fill(app.discoverChosenChipLabel).startsWith(fill(app.discoverChosenChip))).toBe(true);
        expect(fill(app.discoverChosenForeignLabel).startsWith(fill(app.discoverChosenForeignChip))).toBe(true);
    });
});

describe('the chooser is named as the chooser, not as "this window" (the app has other windows)', () => {
    const keys = [
        'photoChooserSaveNoContextHeld',
        'photoChooserSaveNotLoggedIn',
        'photoChooserSaveUnconfirmed',
    ] as const;
    test.each(keys)('%s: English says "the chooser", Latvian names the dialog by its title', (key) => {
        expect(english.app[key]).not.toMatch(/this window/i);
        expect(english.app[key]).toMatch(/the chooser/);
        expect(latvian.app[key]).not.toMatch(/šo logu/i);
        // „Izvēlēties foto” is the dialog's own title (photoChooserTitle).
        expect(latvian.app[key]).toContain(`„${latvian.app.photoChooserTitle}”`);
    });
});
