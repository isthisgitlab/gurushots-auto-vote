/**
 * The frozen 1.x profile-name rules: which names are reserved, how a name is normalized to an identity, and how a
 * stored name is found. Profile and scenario lookups in 1.x all go through these.
 */

// Names that would reassign the prototype of a plain map instead of storing data; 1.x skips them on every read.
const V1_RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The identity key of a profile or scenario name: trimmed and lowercased ('' for a non-string).
 */
const normalizeV1ProfileName = (name: unknown): string => (typeof name === 'string' ? name.trim().toLowerCase() : '');

/**
 * Whether a map holds a name that normalizes to `normalizedName`, skipping reserved stored names.
 */
const hasV1ProfileNamed = (stored: object, normalizedName: string): boolean =>
    Object.keys(stored).some((name) => {
        const key = normalizeV1ProfileName(name);
        return !V1_RESERVED_PROFILE_NAMES.has(key) && key === normalizedName;
    });

export { V1_RESERVED_PROFILE_NAMES, hasV1ProfileNamed, normalizeV1ProfileName };
