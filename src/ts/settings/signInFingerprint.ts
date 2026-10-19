/**
 * A fingerprint of the sign-in (`token`, `apiHeaders`, `lastUsername`, `chosenPhotosMemberId`) the mirror last wrote to
 * `settings.json`, and the reading of what an older build did to it since. The marker keeps the fingerprint, never the
 * sign-in itself. A sign-in is the user's decision (a sign-out, another account), not something an older build's schema
 * can get wrong, so a sign-in that changed in `settings.json` while an older build ran is taken over; nothing else in
 * `settings.json` ever is.
 */

import { isPlainObject } from '../plainObject';
import { AUTH_KEYS, authValueAllowed } from './loadValidation';

import type { ConfigAuthV2 } from '../types/config';

const emptySignIn: ConfigAuthV2 = { token: '', apiHeaders: {}, lastUsername: '', chosenPhotosMemberId: '' };

// A 53-bit non-cryptographic hash (cyrb53 by bryc, public domain; https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js): it tells two values apart. It is not a secret: a
// low-entropy value (a user name) can be found by brute force, which is why the marker sits beside files that hold the
// same values in plain text.
const hash = (text: string): string => {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
};

// The hash of one field, from its canonical text (the headers in key order; their names are unique).
const fieldHash = (key: (typeof AUTH_KEYS)[number], value: unknown): string =>
    hash(
        JSON.stringify(
            key === 'apiHeaders' && isPlainObject(value)
                ? Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))
                : value,
        ),
    );

/**
 * The fingerprint of a sign-in: the hashes of its four fields, each of its own, so that a file that holds only some of
 * the fields (an older build drops the keys it does not know) can be compared field by field.
 */
const signInFingerprint = (auth: ConfigAuthV2): string => AUTH_KEYS.map((key) => fieldHash(key, auth[key])).join('.');

/** The sign-in fields a `settings.json` holds (a field it does not hold, or holds as a value of the wrong kind, was not decided there); null when the text is no settings object. */
const signInFieldsIn = (legacyText: string | null): Partial<ConfigAuthV2> | null => {
    if (legacyText === null) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(legacyText);
    } catch {
        return null;
    }
    if (!isPlainObject(parsed)) return null;
    const found: Partial<ConfigAuthV2> = {};
    for (const key of AUTH_KEYS) {
        if (Object.hasOwn(parsed, key) && authValueAllowed(key, parsed[key]))
            Object.assign(found, { [key]: parsed[key] });
    }
    return found;
};

/**
 * The sign-in fields an older build changed in `settings.json` since this build wrote it, or null when it did not (or
 * nothing says so: no fingerprint is recorded, the text is no settings object, or it holds no sign-in field). Compared
 * field by field: a field the file holds is this build's when its hash is one a recorded fingerprint has for that
 * field, so the fields an older build dropped, and the fields this build changed since it last wrote, are not taken
 * for the older build's.
 *
 * @param legacyText - the text `settings.json` holds
 * @param recorded - the fingerprints the mirror recorded of what it wrote (see importMarker.ts mirroredSignIns)
 */
const signInChangedByOlderBuild = (
    legacyText: string | null,
    recorded: readonly string[],
): Partial<ConfigAuthV2> | null => {
    const found = recorded.length === 0 ? null : signInFieldsIn(legacyText);
    if (found === null) return null;
    const known = recorded.map((fingerprint) => fingerprint.split('.'));
    const changed: Partial<ConfigAuthV2> = {};
    for (const [index, key] of AUTH_KEYS.entries()) {
        const value = found[key];
        if (value !== undefined && !known.some((hashes) => hashes[index] === fieldHash(key, value))) {
            Object.assign(changed, { [key]: value });
        }
    }
    return Object.keys(changed).length === 0 ? null : changed;
};

/**
 * Whether `token` is the one a recorded sign-in names: its hash is the token hash of one of the `recorded` fingerprints.
 * A token of any other sign-in (a later login) never matches, whatever order anything is stored in.
 */
const tokenInSignIns = (recorded: readonly string[], token: string): boolean => {
    const index = AUTH_KEYS.indexOf('token');
    const hashed = fieldHash('token', token);
    return recorded.some((fingerprint) => fingerprint.split('.')[index] === hashed);
};

/**
 * The fingerprint of the sign-in `settings.json` holds when it holds all four fields and they are one this build wrote
 * (it matches a recorded fingerprint), else null.
 */
const signInWrittenHere = (legacyText: string | null, recorded: readonly string[]): string | null => {
    const found = signInFieldsIn(legacyText);
    if (found === null || AUTH_KEYS.some((key) => found[key] === undefined)) return null;
    const fingerprint = signInFingerprint({ ...emptySignIn, ...found });
    return recorded.includes(fingerprint) ? fingerprint : null;
};

/** The fingerprint of the sign-in `settings.json` holds when it holds a token (an older build wrote it, or this one), else null. */
const signInHeldIn = (legacyText: string | null): string | null => {
    const found = signInFieldsIn(legacyText);
    return found?.token ? signInFingerprint({ ...emptySignIn, ...found }) : null;
};

export { signInChangedByOlderBuild, signInFingerprint, signInHeldIn, signInWrittenHere, tokenInSignIns };
