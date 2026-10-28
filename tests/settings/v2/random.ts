/**
 * Seeded random 1.x settings files for the equivalence harness. A seed gives the same file and the same challenge list
 * on every machine. Setting values are drawn from each key's own domain and run through the frozen validator, so a
 * file is read for what it resolves to rather than dropped at load time; rules, profiles, scenarios, challenge values,
 * suppressions, pins and title pins are mixed, a few of them deliberately invalid where the resolver (not the loader)
 * is the one to refuse them.
 */

import { V1_SETTINGS_SCHEMA } from '../../../src/ts/settings/importV1/schema';
import {
    autoSpendCount,
    beforeEndList,
    coinAmount,
    currencyReserve,
    currencyRuleSec,
    discoverUpcomingHours,
    entrySlotIndex,
    fillSchedule,
    finalWindowDurationSec,
    joinPercentElapsed,
    joinWindowHours,
    minute1to59,
    nonNegInt,
    nonNegNumber,
    notifyLeadMinutes,
    pauseDurationMinutes,
    percentage,
    percentageOrZero,
    photoIdList,
    scenarioName,
    startupDelaySeconds,
    swapVoteCeiling,
    tagsList,
    timeOfDayList,
    windowMinutes,
    zBool,
    zString,
} from '../../../src/ts/settings/importV1/validators';
import { at, HOUR, NOW } from './fixtures/types';

import type { z } from 'zod';
import type { MatchTarget } from '../../helpers/v1Oracle/ruleMatching';
import type { Values } from './fixtures/types';

/** A file and what it is read against. */
type Case = {
    name: string;
    raw: string;
    /** The file the oracle reads when it differs from `raw` (a deliberate difference in meaning); `raw` otherwise. */
    oracleRaw?: string;
    challenges: MatchTarget[];
    offList: string[];
    candidates: MatchTarget[];
};

/** The seeded generator behind every random choice. */
type Rng = {
    chance: (probability: number) => boolean;
    int: (min: number, max: number) => number;
    pick: <T>(items: readonly T[]) => T;
    some: <T>(items: readonly T[], max: number) => T[];
};

// mulberry32: small, fast, and the same everywhere.
const makeRng = (seed: number): Rng => {
    let state = seed >>> 0;
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
    const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)];
    return {
        chance: (probability) => next() < probability,
        int,
        pick,
        some: <T>(items: readonly T[], max: number): T[] => {
            const chosen = new Set<T>();
            const count = int(1, Math.max(1, max));
            for (let i = 0; i < count; i += 1) chosen.add(pick(items));
            return [...chosen];
        },
    };
};

const TITLES = ['Aurora Borealis', 'Harbor Lights', 'Wild Macro', 'Street Poetry', 'Golden Hour', 'Silent Forest'];
const CHALLENGE_TAGS = ['Exhibition', 'Comm', 'No comm', 'Turbo', 'Magazine', 'special 4 pic'];
const TYPES = ['default', 'flash', 'special'];
const PHOTO_TAGS = ['sky', 'macro', 'night', 'bw', 'street'];
const SCENARIOS = ['Plan A', 'Plan B', 'Plan C'];
const PROFILES = ['Night', 'day', 'Boost it'];
const ZONES = ['UTC', 'Europe/Riga', 'Asia/Kolkata', 'America/New_York', ''];
const TIMES = ['00:00', '06:30', '09:00', '12:00', '15:00', '17:30', '18:00', '23:45'];

type Generator = (rng: Rng) => unknown;

const listOf =
    (pool: readonly string[], max: number): Generator =>
    (rng) =>
        rng.chance(0.2) ? [] : rng.some(pool, max);

const csv =
    (pool: readonly string[]): Generator =>
    (rng) =>
        rng.chance(0.25) ? '' : rng.some(pool, 3).join(rng.pick([',', ', ', ' , ']));

// How each validator's domain is sampled; a key with a meaning of its own has one below.
const BY_VALIDATOR = new Map<z.ZodType, Generator>([
    [zBool, (rng) => rng.chance(0.5)],
    [zString, csv(TYPES)],
    [percentage, (rng) => rng.int(1, 100)],
    [percentageOrZero, (rng) => (rng.chance(0.3) ? 0 : rng.int(0, 100))],
    [nonNegNumber, (rng) => rng.pick([0, 0, 30, 300, 900, 1800, 3600, 7200, 86400])],
    [minute1to59, (rng) => rng.int(1, 59)],
    [entrySlotIndex, (rng) => rng.int(0, 4)],
    [joinPercentElapsed, (rng) => rng.pick([0, 0, 25, 50, 75, 99])],
    [joinWindowHours, (rng) => rng.pick([0, 0, 1, 6, 12, 24, 72])],
    [coinAmount, (rng) => rng.pick([0, 0, 10, 50, 1000])],
    [autoSpendCount, (rng) => rng.int(1, 10)],
    [currencyReserve, (rng) => rng.pick([0, 1, 5, 100])],
    [swapVoteCeiling, (rng) => rng.pick([0, 100, 5000])],
    [currencyRuleSec, (rng) => rng.pick([0, 0, 600, 3600, 86400])],
    [finalWindowDurationSec, (rng) => rng.pick([60, 1800, 3600, 7200])],
    [notifyLeadMinutes, (rng) => rng.int(1, 60)],
    [discoverUpcomingHours, (rng) => rng.pick([0, 24, 72, 168])],
    [startupDelaySeconds, (rng) => rng.pick([0, 30, 60, 600])],
    [nonNegInt, (rng) => rng.int(0, 5)],
    [windowMinutes, (rng) => rng.pick([5, 30, 60, 240, 720])],
    [pauseDurationMinutes, (rng) => rng.pick([5, 60, 240, 720])],
    [scenarioName, (rng) => rng.pick(['', ...SCENARIOS, 'Ghost'])],
    [tagsList, listOf(PHOTO_TAGS, 3)],
    [photoIdList, (rng) => (rng.chance(0.3) ? [] : rng.some(['p1', 'p2', 'p3', 'p-4', 'p_5'], 3))],
    [timeOfDayList, (rng) => (rng.chance(0.3) ? [] : rng.some(TIMES, 3))],
    [beforeEndList, (rng) => (rng.chance(0.3) ? [] : rng.some([60, 600, 3600, 7200], 3))],
    [
        fillSchedule,
        (rng) =>
            [2, 3, 4]
                .filter(() => rng.chance(0.6))
                .map((count) => ({ count, seconds: rng.pick([0, 300, 1800, 3600]) })),
    ],
]);

// Keys that name something: the pools below keep their references landing on what the file holds.
const BY_KEY: Record<string, Generator> = {
    autoJoinTypes: csv(TYPES),
    autoJoinExcludeTypes: csv(TYPES),
    autoJoinChallengeTags: csv(CHALLENGE_TAGS.map((tag) => tag.toLowerCase())),
    autoJoinExcludeChallengeTags: csv(CHALLENGE_TAGS.map((tag) => tag.toLowerCase())),
    skipUpdateVersion: (rng) => rng.pick(['', '1.2.3']),
};

const SCHEMA_KEYS = Object.keys(V1_SETTINGS_SCHEMA);
const PER_CHALLENGE_KEYS = SCHEMA_KEYS.filter(
    (key) => V1_SETTINGS_SCHEMA[key as keyof typeof V1_SETTINGS_SCHEMA].perChallenge,
);
// What a rule may hold inline, and what a phase may overlay (a phase may not change the assignment or manualPhotosOnly).
const INLINE_KEYS = [
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
const PHASE_KEYS = PER_CHALLENGE_KEYS.filter(
    (key) =>
        ![
            'scenario',
            'manualPhotosOnly',
            'exposure',
            'exposureTarget',
            'finalWindowExposure',
            'finalWindowExposureTarget',
        ].includes(key),
);

/**
 * One draw from a key's domain, before the validator has judged it.
 */
const drawFor = (rng: Rng, key: string): unknown => {
    const entry = V1_SETTINGS_SCHEMA[key as keyof typeof V1_SETTINGS_SCHEMA];
    const generate = BY_KEY[key] ?? BY_VALIDATOR.get(entry.validation);
    if (!generate) throw new Error(`no generator for ${key}`);
    return generate(rng);
};

/**
 * A value from one key's domain that its frozen validator accepts (its default when ten draws are all refused).
 */
const valueFor = (rng: Rng, key: string): unknown => {
    const entry = V1_SETTINGS_SCHEMA[key as keyof typeof V1_SETTINGS_SCHEMA];
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const candidate = drawFor(rng, key);
        if (entry.validation.safeParse(candidate).success) return candidate;
    }
    return entry.default;
};

// Some keys of a value set, the trigger and its target together most of the time.
const valuesOf = (rng: Rng, keys: readonly string[], count: number): Values => {
    const values: Values = {};
    for (const key of rng.some(keys, count)) values[key] = valueFor(rng, key);
    if (typeof values.exposure === 'number' && rng.chance(0.7)) {
        values.exposureTarget = rng.chance(0.3) ? 0 : rng.int(values.exposure, 100);
    }
    if (typeof values.finalWindowExposure === 'number' && rng.chance(0.7)) {
        values.finalWindowExposureTarget = rng.chance(0.3) ? 0 : rng.int(values.finalWindowExposure, 100);
    }
    return values;
};

const challengesOf = (rng: Rng): MatchTarget[] =>
    Array.from({ length: rng.int(3, 6) }, (_, index) => {
        const closeHours = rng.int(1, 80);
        const runtime = rng.pick([2, 24, 72, 200]);
        return {
            id: rng.chance(0.2) ? 200 + index : String(200 + index),
            title: rng.chance(0.1) ? rng.pick([null, '', '  ']) : rng.pick(TITLES),
            tags: rng.chance(0.1) ? 'junk' : rng.some(CHALLENGE_TAGS, 3).filter(() => rng.chance(0.8)),
            type: rng.pick(TYPES),
            max_photo_submits: rng.pick([1, 2, 4, 4, null]),
            start_time: at(closeHours - runtime),
            close_time: NOW + closeHours * HOUR + rng.pick([0, 0, 1800]),
        };
    });

const candidatesOf = (rng: Rng, challenges: MatchTarget[]): MatchTarget[] =>
    Array.from({ length: 3 }, (_, index) => ({
        id: String(800 + index),
        title: rng.chance(0.5) ? rng.pick(TITLES) : `New ${rng.pick(TITLES)}`,
        tags: rng.some(CHALLENGE_TAGS, 2),
        type: rng.pick(TYPES),
        max_photo_submits: rng.pick([2, 4]),
        start_time: at(-2),
        close_time: Number(challenges[index]?.close_time ?? at(10)),
    }));

const localTimeOf = (epochSec: number, zone: string): string => {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone || 'Europe/Riga',
        hourCycle: 'h23',
        hour: '2-digit',
        minute: '2-digit',
    }).format(epochSec * 1000);
    return parts;
};

const ruleOf = (rng: Rng, challenges: MatchTarget[], zone: string, profiles: string[], scenarios: string[]): Values => {
    const source = rng.pick(challenges);
    const rule: Values = {};
    const title = typeof source.title === 'string' ? source.title.trim() : '';
    const conditions = rng.int(1, 3);
    for (let i = 0; i < conditions; i += 1) {
        const kind = rng.int(0, 6);
        if (kind <= 2 && title) {
            const mode = rng.pick(['exact', 'contains', 'starts']);
            const word = title.split(' ')[0];
            const text = mode === 'exact' ? title : mode === 'starts' ? word : title.slice(2, 7);
            rule.title = rng.chance(0.3) ? text.toLowerCase() : text;
            if (mode !== 'exact') rule.match = mode;
            if (rng.chance(0.2)) rule.titles = [rule.title, rng.pick(TITLES)];
        } else if (kind === 3 && Array.isArray(source.tags) && source.tags.length > 0) {
            rule.challengeTag = rng.pick(source.tags as string[]);
        } else if (kind === 4) {
            rule.type = rng.chance(0.8) ? String(source.type) : rng.pick(TYPES);
        } else if (kind === 5) {
            rule.pics = rng.chance(0.8) ? Number(source.max_photo_submits) || 4 : rng.pick([1, 2, 3, 4]);
        } else if (kind === 6 && source.close_time !== undefined) {
            const local = localTimeOf(Number(source.close_time), zone);
            if (rng.chance(0.5)) rule.closesAt = local;
            else rule.closesAtTimes = [rng.pick(TIMES), local];
        }
    }
    if (rng.chance(0.15)) {
        rule.minHours = rng.pick([1, 10, 48]);
        rule.maxHours = rng.pick([100, 500]);
    }
    if (rng.chance(0.4))
        rule.profile = rng.pick(
            [...profiles, 'Missing', 'constructor'].map((name) => (rng.chance(0.3) ? name.toUpperCase() : name)),
        );
    for (const key of rng.some(INLINE_KEYS, 3)) {
        if (rng.chance(0.6))
            rule[key] = rng.chance(0.07) ? rng.pick([null, '', 'bad', -5, 'x'.repeat(70)]) : valueFor(rng, key);
    }
    if (rng.chance(0.35)) rule.scenario = rng.pick([...scenarios, ...scenarios, '', 'Ghost']);
    if (rng.chance(0.3)) rule.mustIncludeTags = rng.some(PHOTO_TAGS, 3);
    if (rng.chance(0.2)) rule.shouldIncludeTags = rng.some(PHOTO_TAGS, 2);
    return rule;
};

const scenarioOf = (rng: Rng, name: string): Values => {
    const phases: Values = {};
    const names = ['alpha', 'beta', 'gamma', 'delta'].slice(0, rng.int(1, 4));
    for (const phase of names) {
        const settings = rng.chance(0.8) ? valuesOf(rng, PHASE_KEYS, 4) : undefined;
        if (settings && rng.chance(0.1)) settings[rng.pick(['scenario', 'manualPhotosOnly', 'token', 'nope'])] = true;
        if (settings && rng.chance(0.4) && !('exposure' in settings)) {
            const exposure = rng.int(1, 80);
            settings.exposure = exposure;
            settings.exposureTarget = rng.int(exposure, 100);
        }
        phases[phase] = {
            ...(settings ? { settings } : {}),
            ...(rng.chance(0.3) ? { rules: [{ do: [{ type: 'notify', message: `in ${phase}` }] }] } : {}),
        };
    }
    return { name, version: 1, start: rng.chance(0.07) ? 'nowhere' : names[0], phases };
};

/**
 * The case for one seed.
 */
const randomCase = (seed: number): Case => {
    const rng = makeRng(seed);
    const zone = rng.pick(ZONES);
    const challenges = challengesOf(rng);
    const candidates = candidatesOf(rng, challenges);
    const ids = challenges.map((challenge) => String(challenge.id));
    const profileNames = rng.some(PROFILES, 3);

    const profiles: Values = {};
    for (const name of profileNames) {
        const values = valuesOf(rng, PER_CHALLENGE_KEYS, 6);
        if (rng.chance(0.15)) values[rng.pick(['token', 'nope', 'currencyReserveKeys'])] = 1;
        if (rng.chance(0.1)) values.exposure = rng.pick([0, 101, 'x']);
        profiles[rng.chance(0.2) ? name.toUpperCase() : name] = rng.chance(0.05) ? 'junk' : values;
    }
    const scenarios: Values = {};
    for (const name of rng.chance(0.75) ? rng.some(SCENARIOS, 3) : []) {
        scenarios[rng.chance(0.2) ? name.toLowerCase() : name] = scenarioOf(rng, name);
    }
    const scenarioNames = Object.keys(scenarios);
    const globalDefaults = rng.chance(0.85) ? valuesOf(rng, SCHEMA_KEYS, 14) : {};
    const perChallenge: Values = {};
    for (const id of [...ids, ...candidates.map((candidate) => String(candidate.id))]) {
        if (rng.chance(0.5)) perChallenge[id] = valuesOf(rng, PER_CHALLENGE_KEYS, 5);
        if (perChallenge[id] && rng.chance(0.5))
            (perChallenge[id] as Values).scenario = rng.pick([...scenarioNames, ...scenarioNames, '', 'Ghost']);
    }
    const titleProfileSuppressions = Object.fromEntries(
        ids.filter(() => rng.chance(0.3)).map((id) => [id, rng.pick([true, true, false, 'yes'])]),
    );
    const entryPins = Object.fromEntries(
        ids
            .filter(() => rng.chance(0.3))
            .map((id) => [id, rng.pick([{ boost: 'e1' }, { turbo: 'e2' }, { boost: 'e1', turbo: 'e3' }, 'junk'])]),
    );
    const titlePins = Object.fromEntries(
        [...ids, '299']
            .filter(() => rng.chance(0.5))
            .map((id) => [id, rng.chance(0.7) ? rng.pick(TITLES) : rng.pick(['', 7])]),
    );
    const legacy = rng.chance(0.25);
    const blob: Values = {
        timezone: zone,
        language: rng.pick(['en', 'lv']),
        ...(legacy
            ? {}
            : Object.fromEntries(
                  [
                      '_timeUnitMigratedV1',
                      '_emergencyFillTimeMigratedV1',
                      '_autoFillScheduleMigratedV1',
                      '_autoFillScheduleBoundsV1',
                      '_scheduledFillListsMigratedV1',
                      '_scheduledFillListBoundsV1',
                      '_finalWindowExposureRenamedV1',
                      '_challengeRulesOrderedV1',
                  ].map((flag) => [flag, true]),
              )),
        challengeSettings: {
            globalDefaults,
            perChallenge,
            titleRules: Array.from({ length: rng.int(0, 6) }, () =>
                ruleOf(rng, challenges, zone, profileNames, scenarioNames),
            ),
            titleProfileSuppressions,
            entryPins,
            profiles,
            seededProfiles: [],
            scenarios,
            titlePins,
            ...(legacy && rng.chance(0.5) ? { categoryRules: [{ type: rng.pick(TYPES) }, { pics: 4 }] } : {}),
        },
    };
    return { name: `seed ${seed}`, raw: JSON.stringify(blob), challenges, offList: ['299', '290', '291'], candidates };
};

/**
 * The seeds a `V2_SEEDS` value names: a comma list of seeds and ranges (`7,100-140`); the default seeds when it is
 * absent or blank.
 */
const parseSeeds = (spec: string | undefined, defaults: number[]): number[] =>
    spec === undefined || spec.trim() === ''
        ? defaults
        : spec.split(',').flatMap((part) => {
              const [from, to = from] = part.split('-').map((value) => Number(value.trim()));
              return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
          });

export { drawFor, makeRng, parseSeeds, randomCase, SCHEMA_KEYS, valueFor };
export type { Case };
