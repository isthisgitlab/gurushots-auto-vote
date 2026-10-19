/**
 * The 1.x value layer of the resolver, frozen: validating one setting (with the cross-field checks), the profile
 * store (names, lookup, sanitizing a profile's values), the effective global values, and the checks a rule's inline
 * values and a profile's whole value set must pass. A copy of `settings/schema.ts` (`validateSetting`),
 * `settings/profileStore.ts`, `settings/defaults.ts`, `settings/ruleBehaviour.ts` and `sanitizeTitleRuleInline` as of
 * the last 1.x release, over the frozen schema; it never follows the live code.
 */

import { isPlainObject } from '../../../src/ts/plainObject';
import { V1_SETTINGS_SCHEMA, v1SchemaEntry } from '../../../src/ts/settings/importV1/schema';

import type { V1Blob, V1Values } from '../../../src/ts/settings/importV1/types';

type ContextValidator = (value: unknown, allSettings: Record<string, unknown>) => boolean;

const effectiveExposureOf = (allSettings: Record<string, unknown>): number => {
    const exposure = allSettings.exposure;
    return typeof exposure === 'number' && exposure >= 1 && exposure <= 100 ? exposure : 100;
};

// The cross-field checks of the three keys with `dependsOn`.
const CONTEXT_VALIDATORS: Record<string, ContextValidator> = {
    exposureTarget: (value, allSettings) => value === 0 || (value as number) >= effectiveExposureOf(allSettings),
    finalWindowExposure: (value, allSettings) => (value as number) <= effectiveExposureOf(allSettings),
    finalWindowExposureTarget: (value, allSettings) => {
        if (value === 0) return true;
        const trigger = allSettings.finalWindowExposure;
        const effectiveTrigger = typeof trigger === 'number' && trigger >= 1 && trigger <= 100 ? trigger : 100;
        return (value as number) >= effectiveTrigger;
    },
};

/** One setting value against its key's validator and cross-field check (a key the schema does not know is valid). */
const validateSetting = (key: string, value: unknown, allSettings: Record<string, unknown> | null = null): boolean => {
    const entry = v1SchemaEntry(key);
    if (!entry) return true;
    if (!entry.validation.safeParse(value).success) return false;
    if (allSettings && Object.hasOwn(CONTEXT_VALIDATORS, key)) return CONTEXT_VALIDATORS[key](value, allSettings);
    return true;
};

const RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const normalizeProfileName = (name: unknown): string => (typeof name === 'string' ? name.trim().toLowerCase() : '');

/** The stored profiles map when it is a plain object, else `{}`. */
const readProfilesMap = (blob: V1Blob): Record<string, unknown> => {
    const stored = blob.challengeSettings.profiles;
    return isPlainObject(stored) ? stored : {};
};

/** The stored key of the profile named `normalizedName`, skipping reserved names; null when there is none. */
const findProfileKey = (stored: object, normalizedName: string): string | null => {
    for (const name of Object.keys(stored)) {
        const key = normalizeProfileName(name);
        if (RESERVED_PROFILE_NAMES.has(key)) continue;
        if (key === normalizedName) return name;
    }
    return null;
};

/** Keys that exist only as "on": a `false` is dropped from a rule or a profile. */
const ON_ONLY_KEYS: readonly string[] = ['manualPhotosOnly'];

const isDroppedOffValue = (key: string, value: unknown): boolean => value === false && ON_ONLY_KEYS.includes(key);

/** Every schema key's effective global value; a challenge-only key always has its schema default. */
const globalChallengeValues = (blob: V1Blob): V1Values => {
    const values: V1Values = {};
    for (const [key, entry] of Object.entries(V1_SETTINGS_SCHEMA)) values[key] = entry.default;
    Object.assign(values, blob.challengeSettings.globalDefaults);
    for (const [key, entry] of Object.entries(V1_SETTINGS_SCHEMA)) {
        if ('challengeOnly' in entry) values[key] = entry.default;
    }
    return values;
};

/**
 * The candidate keys of a value set, and every per-challenge key that (transitively) depends on one of them,
 * validated against the whole `values` as context.
 */
const challengeValueSetIsValid = (values: V1Values, candidates: V1Values): boolean => {
    const affected = new Set(Object.keys(candidates));
    let changed = true;
    while (changed) {
        changed = false;
        for (const [key, entry] of Object.entries(V1_SETTINGS_SCHEMA) as Array<
            [string, { perChallenge: boolean; dependsOn?: readonly string[] }]
        >) {
            if (affected.has(key) || !entry.perChallenge || !entry.dependsOn?.some((dep) => affected.has(dep)))
                continue;
            affected.add(key);
            changed = true;
        }
    }
    if (values.useFinalWindowExposure === true) {
        affected.add('finalWindowExposure');
        affected.add('finalWindowExposureTarget');
    }
    return Array.from(affected).every((key) => {
        const entry = v1SchemaEntry(key);
        if (!entry?.perChallenge) return true;
        const inheritedFinalWindowValue =
            !Object.hasOwn(candidates, key) && (key === 'finalWindowExposure' || key === 'finalWindowExposureTarget');
        if (inheritedFinalWindowValue && values.useFinalWindowExposure !== true) return true;
        return validateSetting(key, values[key], values);
    });
};

const profileSchemaValues = (values: V1Values): V1Values => {
    const whitelisted: V1Values = {};
    for (const key of Object.keys(values)) {
        if (v1SchemaEntry(key)?.perChallenge && !isDroppedOffValue(key, values[key])) whitelisted[key] = values[key];
    }
    return whitelisted;
};

/**
 * A profile's values map sanitized: only per-challenge keys, each validated with the whole batch as context.
 * `failClosed`: null on any invalid value or on a conflict with the inherited values; otherwise invalid values are
 * dropped and a value that is not an object gives `{}`.
 */
const sanitizeProfileValues = (values: unknown, failClosed: boolean, globalDefaults: V1Values): V1Values | null => {
    const rejected = failClosed ? null : {};
    if (!isPlainObject(values) || Object.keys(values).length > 100) return rejected;
    const whitelisted = profileSchemaValues(values);
    const context = { ...globalDefaults, ...whitelisted };
    const sanitized: V1Values = {};
    for (const [key, value] of Object.entries(whitelisted)) {
        if (validateSetting(key, value, context)) {
            sanitized[key] = value;
        } else if (failClosed) {
            return null;
        }
    }
    if (failClosed && !challengeValueSetIsValid(context, whitelisted)) return null;
    return sanitized;
};

/** The settings a rule may override inline, without a named profile. */
const TITLE_RULE_INLINE_KEYS = [
    'autoJoin',
    'autoFill',
    'autoJoinWithinHoursOfEnd',
    'autoJoinAfterPercentElapsed',
    'scenario',
    'chosenPhotos',
    'chosenPhotosOnly',
    'chosenPhotosInOrder',
    'manualPhotosOnly',
];

// The inline keys that only decide whether, and when, an un-joined challenge is joined.
const JOIN_ONLY_INLINE_KEYS = ['autoJoin', 'autoJoinWithinHoursOfEnd', 'autoJoinAfterPercentElapsed'];

/** Whether inline rule values include any that still matter after the join. */
const hasPostJoinInlineValue = (inline: Record<string, unknown>): boolean =>
    Object.keys(inline).some((key) => TITLE_RULE_INLINE_KEYS.includes(key) && !JOIN_ONLY_INLINE_KEYS.includes(key));

/** The inline overrides a rule sets: the allowlisted keys that are not the editor's "inherit" and not a dropped off. */
const ruleInlineEntries = (rule: Record<string, unknown>): Array<[string, unknown]> =>
    TITLE_RULE_INLINE_KEYS.filter((key) => Object.hasOwn(rule, key)).flatMap((key) =>
        rule[key] === null || rule[key] === undefined || rule[key] === '' || isDroppedOffValue(key, rule[key])
            ? []
            : [[key, rule[key]] as [string, unknown]],
    );

/** A rule's inline overrides validated against the schema; null when one is invalid (the rule then gives none). */
const sanitizeTitleRuleInline = (rule: unknown): V1Values | null => {
    const out: V1Values = {};
    for (const [key, value] of isPlainObject(rule) ? ruleInlineEntries(rule) : []) {
        if (!validateSetting(key, value)) return null;
        out[key] = value;
    }
    return out;
};

export {
    CONTEXT_VALIDATORS,
    RESERVED_PROFILE_NAMES,
    challengeValueSetIsValid,
    findProfileKey,
    globalChallengeValues,
    hasPostJoinInlineValue,
    normalizeProfileName,
    readProfilesMap,
    sanitizeProfileValues,
    sanitizeTitleRuleInline,
    validateSetting,
};
