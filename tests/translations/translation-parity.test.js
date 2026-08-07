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
