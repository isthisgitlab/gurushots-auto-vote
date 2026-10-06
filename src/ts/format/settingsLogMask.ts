/**
 * Masking of settings values before they are printed or logged. A settings value can be a
 * whole nested object (the per-challenge map, a rule, a scenario), so the masking is
 * deep: credentials (and the request headers, which carry them) are redacted, the account the settings name is hidden, and chosen
 * photo lists — whose ids belong to one account — are reduced to a count.
 */

import { SENSITIVE_KEY_RE, REDACTED } from '../logger/sanitize';

/** Settings that name the account: never printed or logged, even to the console. */
const PRIVATE_SETTING_KEYS: ReadonlySet<string> = new Set(['lastUsername', 'chosenPhotosMemberId']);

// Deeper than any settings structure (the scenario phase settings are the deepest, at 7
// from the settings root); beyond it nothing is shown rather than risk showing a list.
const MAX_MASK_DEPTH = 10;

/** How a chosen photo list reads in a log or listing: how many, never which. */
const photoCount = (list: readonly unknown[]): string => `${list.length} photo(s)`;

/**
 * `value` with credentials redacted, the account's private settings redacted and every
 * `chosenPhotos` list inside it reduced to a count. Plain values come back as they are.
 */
const maskSettingValue = (value: unknown, depth: number = 0): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_MASK_DEPTH) return '[Object]';
    if (Array.isArray(value)) return value.map((item) => maskSettingValue(item, depth + 1));
    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
            key,
            key === 'apiHeaders' || SENSITIVE_KEY_RE.test(key) || PRIVATE_SETTING_KEYS.has(key)
                ? REDACTED
                : key === 'chosenPhotos' && Array.isArray(item)
                  ? photoCount(item)
                  : maskSettingValue(item, depth + 1),
        ]),
    );
};

export { PRIVATE_SETTING_KEYS, maskSettingValue, photoCount };
