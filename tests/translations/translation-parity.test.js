/**
 * Guards the english.js / latvian.js key contract: every key must exist in
 * both files, in every section, at every depth. A key missing from latvian.js
 * does NOT crash at runtime — t() silently falls back to English — so nothing
 * but this test catches the drift.
 */
const english = require('../../src/js/translations/english');
const latvian = require('../../src/js/translations/latvian');

/**
 * Flatten a nested translation object into sorted 'section.path.key' strings.
 * @param {Record<string, any>} obj
 * @param {string} prefix
 * @returns {string[]}
 */
const flattenKeys = (obj, prefix = '') => {
    const keys = [];
    for (const [key, value] of Object.entries(obj)) {
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
                const value = key.split('.').reduce((node, part) => node[part], translations);
                expect(typeof value).toBe('string');
                expect(value.length).toBeGreaterThan(0);
            }
        }
    });
});

describe('renderer translation keys exist', () => {
    // fs is mocked globally in tests/setup.js; this test reads real sources.
    const fs = jest.requireActual('fs');
    const path = require('path');

    // Literal t('section.key') calls only — dynamic keys (t(variable)) can't be
    // checked statically. A missing key renders as the raw key string in the
    // UI (e.g. "common.cancel"), which nothing else catches.
    const listSources = (dir) =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
            const full = path.join(dir, d.name);
            if (d.isDirectory()) return listSources(full);
            return /\.(jsx?|mjs)$/.test(d.name) ? [full] : [];
        });

    test('every literal t() key in src/js/react resolves in english.js', () => {
        const known = new Set(flattenKeys(english));
        const root = path.join(__dirname, '../../src/js/react');
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
