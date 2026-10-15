/**
 * Conversion of a migrated 1.x settings blob to the 2.x configuration: the sign-in state, the app preferences, the
 * defaults, profiles, scenarios and rules, and the per-challenge state folded into one record per id, with the
 * setting keys renamed. Pure: it reads the blob and builds new values.
 */

import { isPlainObject } from '../../plainObject';
import { V1_MIGRATION_FLAGS } from './migrations';
import { hasV1ProfileNamed, normalizeV1ProfileName, V1_RESERVED_PROFILE_NAMES } from './profiles';
import { isReservedChallengeId } from './loadValidation';
import { renameV1Keys, renameV1ScenarioDocument, renameV1Value } from './renames';

import type { ChallengePinsV2, ChallengeRecordV2, ConfigV2, ImportReportV2 } from '../../types/config';
import type { V1Blob } from './types';

type ConvertedV1 = { config: ConfigV2; titlePins: Record<string, string>; report: ImportReportV2 };

// The top-level keys that become `auth`.
const AUTH_KEYS = ['token', 'apiHeaders', 'lastUsername', 'chosenPhotosMemberId'];

const stringOrEmpty = (value: unknown): string => (typeof value === 'string' ? value : '');

const stringEntries = (value: unknown): Array<[string, string]> =>
    isPlainObject(value)
        ? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        : [];

const mapValues = (value: unknown, convert: (item: unknown) => unknown): Record<string, unknown> =>
    isPlainObject(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, convert(item)])) : {};

// The pinned entry ids of one stored pin record: 1.x reads only string `boost` / `turbo` values.
const pinsOf = (record: unknown): ChallengePinsV2 => {
    const pins: ChallengePinsV2 = {};
    if (isPlainObject(record)) {
        if (typeof record.boost === 'string') pins.boost = record.boost;
        if (typeof record.turbo === 'string') pins.turbo = record.turbo;
    }
    return pins;
};

/**
 * One record per challenge id found in perChallenge, titleProfileSuppressions (value `true` only) or entryPins.
 * An id naming an Object.prototype member is never a challenge and is left out.
 */
const convertChallenges = (blob: V1Blob): Record<string, ChallengeRecordV2> => {
    const { perChallenge, titleProfileSuppressions, entryPins } = blob.challengeSettings;
    const suppressed = Object.keys(titleProfileSuppressions).filter((id) => titleProfileSuppressions[id] === true);
    const ids = new Set([...Object.keys(perChallenge), ...suppressed, ...Object.keys(entryPins)]);
    const challenges: Record<string, ChallengeRecordV2> = {};
    for (const id of ids) {
        if (isReservedChallengeId(id)) continue;
        const record: ChallengeRecordV2 = {};
        if (Object.hasOwn(perChallenge, id)) record.values = renameV1Keys(perChallenge[id]);
        if (suppressed.includes(id)) record.suppressRuleProfile = true;
        if (Object.hasOwn(entryPins, id)) record.pins = pinsOf(entryPins[id]);
        challenges[id] = record;
    }
    return challenges;
};

const quoted = (name: string): string => JSON.stringify(name.slice(0, 80));

/**
 * The references 1.x could not resolve, which stay as stored and block as in 1.x: a rule naming a profile that is
 * missing or reserved, and a `scenario` value naming a scenario that is not stored.
 */
const unresolvedRefs = (config: ConfigV2): string[] => {
    const refs: string[] = [];
    const unresolvedScenario = (path: string, values: unknown) => {
        const name = isPlainObject(values) ? values.scenario : undefined;
        const normalized = normalizeV1ProfileName(name);
        if (normalized !== '' && typeof name === 'string' && !hasV1ProfileNamed(config.scenarios, normalized)) {
            refs.push(`${path}.scenario: ${quoted(name)}`);
        }
    };
    unresolvedScenario('defaults', config.defaults);
    for (const [name, values] of Object.entries(config.profiles)) {
        unresolvedScenario(`profiles[${JSON.stringify(name)}]`, values);
    }
    config.rules.forEach((rule, index) => {
        unresolvedScenario(`rules[${index}]`, rule);
        const profile = isPlainObject(rule) ? rule.profile : undefined;
        const normalized = normalizeV1ProfileName(profile);
        if (
            normalized !== '' &&
            typeof profile === 'string' &&
            (V1_RESERVED_PROFILE_NAMES.has(normalized) || !hasV1ProfileNamed(config.profiles, normalized))
        ) {
            refs.push(`rules[${index}].profile: ${quoted(profile)}`);
        }
    });
    for (const [id, record] of Object.entries(config.challenges)) {
        const path = /^[\w-]+$/.test(id) ? `challenges.${id}` : `challenges[${JSON.stringify(id)}]`;
        unresolvedScenario(`${path}.values`, record.values);
    }
    return refs;
};

/**
 * The 2.x configuration for a merged, migrated, validated and pruned 1.x blob, with the title pins (kept in a cache
 * store, not in the configuration) and the references that could not be resolved.
 */
const convertV1Blob = (blob: V1Blob): ConvertedV1 => {
    const { challengeSettings } = blob;
    const moved = new Set(['challengeSettings', ...AUTH_KEYS, ...V1_MIGRATION_FLAGS]);
    const config: ConfigV2 = {
        version: 2,
        app: renameV1Keys(Object.fromEntries(Object.entries(blob).filter(([key]) => !moved.has(key)))),
        auth: {
            token: stringOrEmpty(blob.token),
            apiHeaders: Object.fromEntries(stringEntries(blob.apiHeaders)),
            lastUsername: stringOrEmpty(blob.lastUsername),
            chosenPhotosMemberId: stringOrEmpty(blob.chosenPhotosMemberId),
        },
        defaults: renameV1Keys(challengeSettings.globalDefaults),
        profiles: mapValues(challengeSettings.profiles, renameV1Value),
        seededProfiles: Array.isArray(challengeSettings.seededProfiles)
            ? challengeSettings.seededProfiles.filter((name): name is string => typeof name === 'string')
            : [],
        scenarios: mapValues(challengeSettings.scenarios, renameV1ScenarioDocument),
        rules: challengeSettings.titleRules.map(renameV1Value),
        challenges: convertChallenges(blob),
    };
    const titlePins = Object.fromEntries(
        stringEntries(challengeSettings.titlePins).filter(([id]) => !isReservedChallengeId(id)),
    );
    return { config, titlePins, report: { refsBlocked: unresolvedRefs(config) } };
};

export { convertV1Blob };
