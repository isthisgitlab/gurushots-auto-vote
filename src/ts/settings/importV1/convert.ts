/**
 * Conversion of a migrated format 1 settings blob to the format 2 configuration: the sign-in state, the app preferences, the
 * defaults, profiles, scenarios and rules, and the per-challenge state folded into one record per id, with the
 * setting keys renamed. Pure: it reads the blob and builds new values.
 */

import { isPlainObject } from '../../plainObject';
import { V1_MIGRATION_FLAGS } from './migrations';
import { hasV1ProfileNamed, normalizeV1ProfileName, V1_RESERVED_PROFILE_NAMES } from './profiles';
import { isReservedChallengeId } from './loadValidation';
import { renameV1Keys, renameV1ScenarioDocument, renameV1Value } from './renames';

import type {
    ChallengePinsV2,
    ChallengeRecordV2,
    ImportRef,
    ImportRefHolder,
    ImportReportV2,
    StoredConfigV2,
} from '../../types/config';
import type { V1Blob, V1Values } from './types';

type ConvertedV1 = { config: StoredConfigV2; titlePins: Record<string, string>; report: ImportReportV2 };

// The top-level keys that become `auth`.
const AUTH_KEYS = ['token', 'apiHeaders', 'lastUsername', 'chosenPhotosMemberId'];

// The schema keys of the app-state flags: format 1 kept them at the top level and read them from there only (a copy among
// the global defaults was never read), so they are `app` values, and `chosenPhotosMemberId` an `auth` one.
const TOP_LEVEL_ONLY_KEYS = new Set([
    'autovoteRunning',
    'autovoteStartedLaunch',
    'skipUpdateVersion',
    'chosenPhotosMemberId',
    'chosenPhotosClearedAt',
    'noticeAcknowledgedVersion',
]);

const withoutKeys = (values: V1Values, dropped: ReadonlySet<string>): V1Values =>
    Object.fromEntries(Object.entries(values).filter(([key]) => !dropped.has(key)));

const stringOrEmpty = (value: unknown): string => (typeof value === 'string' ? value : '');

const stringEntries = (value: unknown): Array<[string, string]> =>
    isPlainObject(value)
        ? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        : [];

/**
 * The `[id, title]` pairs format 1's title lookup finds in a stored `titlePins`. It reads `pinned[id]` of whatever the file
 * holds, for an id the value has as an own property: an object's entries, but also an array's elements by index and
 * a string's characters by index.
 */
const pinnedTitles = (stored: unknown): Array<[string, string]> =>
    stored === null || stored === undefined
        ? []
        : Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === 'string');

const mapValues = (value: unknown, convert: (item: unknown) => unknown): Record<string, unknown> =>
    isPlainObject(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, convert(item)])) : {};

// The pinned entry ids of one stored pin record: format 1 reads only string `boost` / `turbo` values.
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
        if (Object.hasOwn(perChallenge, id)) record.values = renameV1Keys(perChallenge[id], 'drop-targets');
        if (suppressed.includes(id)) record.suppressRuleProfile = true;
        if (Object.hasOwn(entryPins, id)) record.pins = pinsOf(entryPins[id]);
        challenges[id] = record;
    }
    return challenges;
};

// A name shown in a report, shortened (a user-authored name can be any length).
const shortened = (name: string, max: number): string => (name.length > max ? `${name.slice(0, max - 1)}…` : name);

const MAX_NAME_LENGTH = 80;
const MAX_RULE_TITLE_LENGTH = 40;

/** The holder of a reference in the rule at `index` (counted from 0 in the stored order; shown from 1). */
const ruleHolder = (rule: unknown, index: number): ImportRefHolder => {
    const title = isPlainObject(rule) && typeof rule.title === 'string' ? rule.title.trim() : '';
    return {
        kind: 'rule',
        number: index + 1,
        ...(title === '' ? {} : { title: shortened(title, MAX_RULE_TITLE_LENGTH) }),
    };
};

/** The holder of a reference in a challenge's own settings: its title where one is known for the id. */
const challengeHolder = (id: string, titles: Readonly<Record<string, string>>): ImportRefHolder => {
    const title = Object.hasOwn(titles, id) ? titles[id].trim() : '';
    return {
        kind: 'challenge',
        id: shortened(id, MAX_NAME_LENGTH),
        ...(title === '' ? {} : { title: shortened(title, MAX_NAME_LENGTH) }),
    };
};

const profileHolder = (name: string): ImportRefHolder => ({ kind: 'profile', name: shortened(name, MAX_NAME_LENGTH) });

/** A reference to the `profile` or `scenario` called `name`, as the report lists it. */
const refTo = (holder: ImportRefHolder, refers: ImportRef['refers'], name: string, invalid = false): ImportRef => ({
    holder,
    refers,
    name: shortened(name, MAX_NAME_LENGTH),
    ...(invalid ? { invalid: true as const } : {}),
});

/**
 * The references format 1 could not resolve, which stay as stored and block as in format 1: a rule naming a profile that is
 * missing or reserved, and a `scenario` value naming a scenario that is not stored. A `scenario` among the defaults
 * is no reference: it is challenge-only, so format 1 never applied a global value.
 */
const unresolvedRefs = (config: StoredConfigV2, titles: Readonly<Record<string, string>>): ImportRef[] => {
    const refs: ImportRef[] = [];
    const unresolvedScenario = (holder: ImportRefHolder, values: unknown) => {
        const name = isPlainObject(values) ? values.scenario : undefined;
        const normalized = normalizeV1ProfileName(name);
        if (normalized !== '' && typeof name === 'string' && !hasV1ProfileNamed(config.scenarios, normalized)) {
            refs.push(refTo(holder, 'scenario', name));
        }
    };
    for (const [name, values] of Object.entries(config.profiles)) {
        unresolvedScenario(profileHolder(name), values);
    }
    config.rules.forEach((rule, index) => {
        const holder = ruleHolder(rule, index);
        unresolvedScenario(holder, rule);
        const profile = isPlainObject(rule) ? rule.profile : undefined;
        const normalized = normalizeV1ProfileName(profile);
        if (
            normalized !== '' &&
            typeof profile === 'string' &&
            (V1_RESERVED_PROFILE_NAMES.has(normalized) || !hasV1ProfileNamed(config.profiles, normalized))
        ) {
            refs.push(refTo(holder, 'profile', profile));
        }
    });
    for (const [id, record] of Object.entries(config.challenges)) {
        unresolvedScenario(challengeHolder(id, titles), record.values);
    }
    return refs;
};

/**
 * The format 2 configuration for a merged, migrated, validated and pruned format 1 blob, with the title pins (kept in a cache
 * store, not in the configuration) and the references that could not be resolved. `mockStored`: the format 1 file held a
 * `mock` value; without one the configuration has none, so the build's own default applies at load, as format 1's merge did.
 */
const convertV1Blob = (blob: V1Blob, { mockStored }: { mockStored: boolean }): ConvertedV1 => {
    const { challengeSettings } = blob;
    const moved = new Set(['challengeSettings', ...AUTH_KEYS, ...V1_MIGRATION_FLAGS, ...(mockStored ? [] : ['mock'])]);
    const config: StoredConfigV2 = {
        version: 2,
        app: renameV1Keys(Object.fromEntries(Object.entries(blob).filter(([key]) => !moved.has(key))), 'drop-targets'),
        auth: {
            token: stringOrEmpty(blob.token),
            apiHeaders: Object.fromEntries(stringEntries(blob.apiHeaders)),
            lastUsername: stringOrEmpty(blob.lastUsername),
            chosenPhotosMemberId: stringOrEmpty(blob.chosenPhotosMemberId),
        },
        defaults: renameV1Keys(withoutKeys(challengeSettings.globalDefaults, TOP_LEVEL_ONLY_KEYS), 'drop-targets'),
        profiles: mapValues(challengeSettings.profiles, (values) => renameV1Value(values, 'drop-targets')),
        seededProfiles: Array.isArray(challengeSettings.seededProfiles)
            ? challengeSettings.seededProfiles.filter((name): name is string => typeof name === 'string')
            : [],
        scenarios: mapValues(challengeSettings.scenarios, (doc) => renameV1ScenarioDocument(doc, 'drop-targets')),
        rules: challengeSettings.titleRules.map((rule) => renameV1Value(rule, 'drop-targets')),
        challenges: convertChallenges(blob),
    };
    const titlePins = Object.fromEntries(
        pinnedTitles(challengeSettings.titlePins).filter(([id]) => !isReservedChallengeId(id)),
    );
    return { config, titlePins, report: { refsBlocked: unresolvedRefs(config, titlePins) } };
};

export { challengeHolder, convertV1Blob, profileHolder, refTo, ruleHolder, TOP_LEVEL_ONLY_KEYS };
