/**
 * The settings an older build keeps, frozen: the key set and the load of the 1.12.2 build (`master` at a5c23df4, read
 * with `git show master:src/ts/settings/{schema/*,persistence,migrations,migrations/prune,defaults,uiDefaults}.ts`).
 * That build merges the file over its defaults, runs the one-time migrations its flags have not marked done, resets a
 * top-level value of the wrong type, drops what its own validators reject, and prunes every `globalDefaults` and
 * per-challenge key its schema does not define (and every per-challenge map left empty); then it writes the whole file
 * back, even when the user changed nothing.
 *
 * Its validators for a value are the frozen copy in `settings/importV1/schema.ts` (the 1.x schema): `git diff master
 * HEAD` of `settings/schema/*.ts`, `schema/validators.ts` and `limits.ts` shows no validator, range or enum of a key the
 * two builds share changed (the live schema only adds keys, renames the autoFill ones, and adds the range check of a few
 * top-level numbers that 1.12.2 does not make: `apiTimeout`, `apiMaxRetries`, `apiRetryBaseDelayMs`,
 * `checkFrequencyMin/Max`). A value outside a range 1.12.2 has is removed on load, so the default applies.
 */

import { isPlainObject } from '../../../src/ts/plainObject';
import { v1SchemaEntry } from '../../../src/ts/settings/importV1/schema';

/** The schema keys of that build (92). */
const MASTER_KEYS: readonly string[] = [
    'autoBoost',
    'autoClaimPrizes',
    'autoExposureFill',
    'autoExposureFillAfterPercent',
    'autoExposureFillAfterStart',
    'autoExposureFillBeforeEnd',
    'autoExposureFillBelow',
    'autoExposureFillMax',
    'autoFill',
    'autoFillSchedule',
    'autoJoin',
    'autoJoinAfterPercentElapsed',
    'autoJoinChallengeTags',
    'autoJoinCycleCoinBudget',
    'autoJoinExcludeChallengeTags',
    'autoJoinExcludeTypes',
    'autoJoinMaxCoins',
    'autoJoinTypes',
    'autoJoinWithinHoursOfEnd',
    'autoKeyAfterPercent',
    'autoKeyAfterStart',
    'autoKeyBeforeEnd',
    'autoKeyUnlock',
    'autoSwap',
    'autoSwapAfterPercent',
    'autoSwapAfterStart',
    'autoSwapAllowBoosted',
    'autoSwapBeforeEnd',
    'autoSwapImageIndex',
    'autoSwapLowestVotes',
    'autoSwapMax',
    'autoSwapMaxVotes',
    'autoTurbo',
    'autovoteRunning',
    'boostFillNew',
    'boostFillNewOnConflict',
    'boostFreshEntryWait',
    'boostImageIndex',
    'boostTime',
    'compactCardActions',
    'compactCards',
    'currencyReserveFills',
    'currencyReserveKeys',
    'currencyReserveSwaps',
    'emergencyFill',
    'exposure',
    'exposureTarget',
    'fillWithoutTagMatch',
    'finalWindowDuration',
    'finalWindowExposure',
    'finalWindowExposureTarget',
    'ignoreTitleWords',
    'keyUnlockedBoostTime',
    'lastMinuteCheckFrequency',
    'lastMinuteThreshold',
    'missionJoinEarly',
    'missionSaveTurbos',
    'missionUseFills',
    'missionVote',
    'mustIncludeTags',
    'notifyLeadTime',
    'notifyOnAutoFill',
    'notifyOnBoost',
    'notifyOnEmergencyFill',
    'notifyOnScenario',
    'notifyOnTurbo',
    'onlyBoost',
    'protectUncertainAutoFills',
    'scenario',
    'scheduledFillBeforeEnd',
    'scheduledFillReplaces',
    'scheduledFillTime',
    'scheduledFillWindowMinutes',
    'shouldIncludeTags',
    'skipUpdateVersion',
    'turboFillNew',
    'turboFillNewOnConflict',
    'turboImageIndex',
    'turboTime',
    'useFinalWindowExposure',
    'useScheduledFill',
    'useTurbo',
    'useVotingPause',
    'voteBeforeBoost',
    'voteBeforeBoostLeadMin',
    'voteBeforeFinalWindow',
    'voteBeforeFinalWindowLeadMin',
    'voteOnlyInLastMinute',
    'voteOnNewEntry',
    'votingPauseBeforeEnd',
    'votingPauseDurationMinutes',
    'votingPauseTime',
];

/** The one-time flags of its migrations: a file with all of them set is not migrated again. */
const MASTER_MIGRATION_FLAGS = [
    '_timeUnitMigratedV1',
    '_emergencyFillTimeMigratedV1',
    '_autoFillScheduleMigratedV1',
    '_autoFillScheduleBoundsV1',
    '_scheduledFillListsMigratedV1',
    '_scheduledFillListBoundsV1',
    '_finalWindowExposureRenamedV1',
    '_challengeRulesOrderedV1',
] as const;

// Its defaults for the top-level values it type-checks on load (a value of another type goes back to the default).
const MASTER_TOP_LEVEL_DEFAULTS: Readonly<Record<string, unknown>> = {
    theme: 'light',
    language: 'en',
    timezone: 'Europe/Riga',
    customTimezones: [],
    stayLoggedIn: false,
    apiTimeout: 30,
    checkFrequencyMin: 3,
    checkFrequencyMax: 3,
    apiMaxRetries: 3,
    apiRetryBaseDelayMs: 1000,
    lastUsername: '',
    mock: false,
    token: '',
    onboardingCompleted: false,
};

// The containers of `challengeSettings` it fills and kind-checks.
const MASTER_CONTAINERS = {
    object: ['globalDefaults', 'perChallenge', 'titleProfileSuppressions'],
    array: ['titleRules'],
} as const;

type OlderBuildLoad = {
    /** What it holds once it has loaded (and would write back). */
    blob: Record<string, unknown>;
    /** The top-level values it reset because their type was not its default's. */
    reset: string[];
    /** The keys it pruned from the global defaults and the per-challenge maps, as `path.key`. */
    pruned: string[];
    /** The values its validators removed (they were outside what 1.12.2 accepts), as `path.key`. */
    dropped: string[];
    /** The migrations it would run (flags not marked done): none for a file the mirror wrote. */
    migrations: string[];
};

const hasDefaultsType = (value: unknown, fallback: unknown): boolean =>
    Array.isArray(fallback)
        ? Array.isArray(value) && value.every((item) => typeof item === 'string')
        : typeof value === typeof fallback;

// Removes the values of a map its validators reject (a key it does not define is left to the prune).
const dropRejected = (values: Record<string, unknown>, path: string, dropped: string[]): void => {
    for (const [key, value] of Object.entries(values)) {
        const entry = MASTER_KEYS.includes(key) ? v1SchemaEntry(key) : undefined;
        if (entry && !entry.validation.safeParse(value).success) {
            delete values[key];
            dropped.push(`${path}.${key}`);
        }
    }
};

/**
 * The 1.12.2 build loading a settings.json text: merge, flags, type reset, container fill, validation, prune.
 */
const loadLikeMaster = (text: string): OlderBuildLoad => {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) throw new Error('the older build reads one JSON object');
    const blob: Record<string, unknown> = { ...MASTER_TOP_LEVEL_DEFAULTS, ...parsed };
    const challengeSettings: Record<string, unknown> = {
        globalDefaults: {},
        perChallenge: {},
        titleRules: [],
        titleProfileSuppressions: {},
        ...(isPlainObject(blob.challengeSettings) ? blob.challengeSettings : {}),
    };
    blob.challengeSettings = challengeSettings;
    const migrations = MASTER_MIGRATION_FLAGS.filter((flag) => !blob[flag]);
    const reset: string[] = [];
    for (const [key, fallback] of Object.entries(MASTER_TOP_LEVEL_DEFAULTS)) {
        if (!hasDefaultsType(blob[key], fallback)) {
            blob[key] = fallback;
            reset.push(key);
        }
    }
    for (const key of MASTER_CONTAINERS.object) {
        if (!isPlainObject(challengeSettings[key])) challengeSettings[key] = {};
    }
    for (const key of MASTER_CONTAINERS.array) {
        if (!Array.isArray(challengeSettings[key])) challengeSettings[key] = [];
    }
    const pruned: string[] = [];
    const dropped: string[] = [];
    const globalDefaults = challengeSettings.globalDefaults as Record<string, unknown>;
    dropRejected(globalDefaults, 'globalDefaults', dropped);
    for (const key of Object.keys(globalDefaults).filter((name) => !MASTER_KEYS.includes(name))) {
        delete globalDefaults[key];
        pruned.push(`globalDefaults.${key}`);
    }
    const perChallenge = challengeSettings.perChallenge as Record<string, Record<string, unknown>>;
    for (const [id, values] of Object.entries(perChallenge)) {
        dropRejected(values, `perChallenge.${id}`, dropped);
        for (const key of Object.keys(values).filter((name) => !MASTER_KEYS.includes(name))) {
            delete values[key];
            pruned.push(`perChallenge.${id}.${key}`);
        }
        if (Object.keys(values).length === 0) delete perChallenge[id];
    }
    delete blob.boostConfig;
    return { blob, reset, pruned, dropped, migrations };
};

export { MASTER_KEYS, MASTER_MIGRATION_FLAGS, loadLikeMaster };
