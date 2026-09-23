// @ts-check
const { z } = require('zod');
// Bounds live in the dependency-free limits.js so renderer-reachable modules
// can read them without pulling zod in through this file. Re-exported below to
// keep this module's public surface unchanged.
const { MAX_SCHEDULED_FILL_ENTRIES, MAX_VOTING_PAUSE_MINUTES } = require('./limits');

/**
 * Centralized Settings Schema
 *
 * Single source of truth for all configurable settings. Each entry
 * declares its type, default, validation, and whether it supports
 * per-challenge overrides. Pure module — no fs, logger, or runtime
 * imports — so the schema can be unit-tested directly and the
 * settings facade re-exports the public surface.
 */

/**
 * Shape of a single SETTINGS_SCHEMA entry. All fields are optional so the
 * heterogeneous entries (some carry contextValidation/getContextError, most
 * don't) all fit one type; the typed validator signatures also give the
 * inline `(value) => ...` callbacks contextual typing so they aren't flagged
 * as implicit-any.
 *
 * @typedef {object} SettingsSchemaEntry
 * @property {string} [type]
 * @property {*} [default]
 * @property {boolean} [perChallenge]
 * @property {boolean} [challengeOnly] - Only settable on a challenge or a profile: the key
 *   has NO global value. Hidden from the global settings modal, refused by
 *   setGlobalDefault, and a stored global value is ignored — the schema default applies
 *   until a challenge override or profile sets it. Implies `perChallenge`. Used for the
 *   currency automation, where spending keys/swaps/fills must be an explicit per-challenge
 *   (or per-profile) choice rather than a blanket global switch.
 * @property {import('zod').ZodType} [validation]
 * @property {(value: any, allSettings: any, challengeId?: any) => boolean} [contextValidation]
 * @property {(value: any, allSettings: any, challengeId?: any) => string} [getContextError]
 * @property {string[]} [dependsOn]
 * @property {number} [validationOrder]
 * @property {string} [group]
 * @property {string} [label]
 * @property {string} [description]
 * @property {string} [helpKey] - Translation key for an optional deeper "explain this"
 *   disclosure shown beside the row (e.g. the two distinct meanings of a `0` sentinel).
 *   Display-only, like `description` — never affects validation. Forwarded by the schema
 *   IPC projection alongside `description`.
 * @property {number} [min] - Advertised lower bound, mirroring `validation`. Forwarded to the
 *   renderer by the schema IPC projection and bound to the number input.
 * @property {number} [max] - Advertised upper bound, mirroring `validation`.
 * @property {string} [unit] - Translation key for the suffix shown beside a number input.
 */

/**
 * Helper to read schema defaults at runtime. Defined ahead of
 * SETTINGS_SCHEMA so the contextValidation closures inside the schema
 * can resolve sibling defaults without forward-referencing the constant
 * literal during construction.
 *
 * @param {string} key
 * @returns {*}
 */
const getSchemaDefault = (key) => SETTINGS_SCHEMA[key]?.default;

/**
 * The exposure value the exposure-dependent validators compare against:
 * the live `exposure` from allSettings when it is a valid 1–100 number,
 * otherwise the schema default. Shared by the exposureTarget and
 * finalWindowExposure context validators/error builders.
 *
 * @param {any} allSettings
 * @returns {number}
 */
const effectiveExposureOf = (allSettings) => {
    const exposureValue = allSettings.exposure;
    return typeof exposureValue === 'number' && exposureValue >= 1 && exposureValue <= 100
        ? exposureValue
        : getSchemaDefault('exposure');
};

// Reusable zod validators. Each SETTINGS_SCHEMA entry's `validation` field
// holds one of these schemas; validateSetting / getValidationError run it via
// safeParse. Centralizing the shapes keeps the per-entry declarations
// declarative and the type/range rules in one place. zod's z.number()
// rejects NaN and numeric strings, matching the previous typeof predicates.
const zBool = z.boolean();
const zString = z.string();
const percentage = z.number().min(1).max(100); // exposure-style trigger, 1–100
const percentageOrZero = z.number().min(0).max(100); // target, 0 = "use trigger" sentinel
const nonNegNumber = z.number().min(0); // time fields (seconds before close); 0 = off
// Coin caps for the paid auto-join gate. Integer, 0 = off (no paid spend). The
// ceiling is defense-in-depth against a corrupted settings file, well above any
// real challenge cost / balance.
const MAX_COIN_AMOUNT = 1_000_000;
const coinAmount = z.number().int().min(0).max(MAX_COIN_AMOUNT);
// Auto-join timing window, in hours before a candidate's close_time. 0 = off
// (join as soon as the candidate is seen). The ceiling is 30 days — longer than
// any real GuruShots challenge runs, so any value at or above it behaves as
// "always in window" while still bounding a corrupted settings file.
const MAX_JOIN_WINDOW_HOURS = 720;
const joinWindowHours = z.number().min(0).max(MAX_JOIN_WINDOW_HOURS);
// Auto-join elapsed-fraction anchor, as a PERCENT of the candidate's own
// lifetime (close_time - start_time). 0 = off, same sentinel family as
// MAX_JOIN_WINDOW_HOURS above. This exists because hours-before-close does not
// transfer across challenge lengths: the live payload carries 2h flash
// challenges and 515h exhibitions side by side (verified 2026-09-19), so one
// absolute window is either far too late for the short ones or far too early
// for the long ones. A percentage is scale-free — 75 means "join once
// three-quarters of the challenge has run", whatever its length.
// The ceiling is 99, NOT 100: a candidate is only 100% elapsed at the instant
// its close_time passes, and the gate refuses an already-closed challenge before
// it ever reads the fraction. Allowing 100 would therefore ship a maximum that
// silently never joins anything. 99 is the latest value that can actually fire.
const MAX_JOIN_PERCENT_ELAPSED = 99;
const joinPercentElapsed = z.number().min(0).max(MAX_JOIN_PERCENT_ELAPSED);
// Entry-slot index: 1-4 selects a slot, 0 is the "last entry" sentinel. GuruShots challenges
// carry at most four submissions (max_photo_submits tops out at 4, which is also why the
// auto-fill schedule only covers images 2-4), so anything above 4 could never name a real
// slot — it used to be accepted and then silently clamped to the last entry at pick time.
const MAX_ENTRY_SLOT = 4;
const entrySlotIndex = z.number().int().min(0).max(MAX_ENTRY_SLOT);
// Currency automation (keys / swaps / fills). Per-challenge spend caps: how many
// automatic swaps / exposure fills one challenge may receive. 1..10 — at least one,
// or the enable toggle would be a no-op, and 10 is far above any real balance.
const MAX_AUTO_SPENDS_PER_CHALLENGE = 10;
const autoSpendCount = z.number().int().min(1).max(MAX_AUTO_SPENDS_PER_CHALLENGE);
// Global reserve: keep at least this many of a currency; automation never spends
// below it (manual spends are unaffected). 0 = no reserve.
const MAX_CURRENCY_RESERVE = 1000;
const currencyReserve = z.number().int().min(0).max(MAX_CURRENCY_RESERVE);
// Vote-count ceiling for the swap "only when the entry has fewer than N votes"
// rule. 0 = no vote condition.
const MAX_SWAP_VOTE_CEILING = 1_000_000;
const swapVoteCeiling = z.number().int().min(0).max(MAX_SWAP_VOTE_CEILING);
// Shared 1–59 range, preserving the previous predicates exactly: used by both
// lastMinuteThreshold (minutes-before-close that count as "last minute") and
// lastMinuteCheckFrequency (poll cadence in minutes). Neither is required to be
// an integer (matching prior behavior); the 59 ceiling keeps both within the hour.
const minute1to59 = z.number().min(1).max(59);

// Notification lead time (minutes before an action fires that a warning is
// shown). 1–60; integer minutes are enough resolution for a "don't shut down
// yet" heads-up.
const notifyLeadMinutes = z.number().int().min(1).max(60);

// Auto-fill schedule: rows of { count, seconds } meaning "have ≥ count entries
// once ≤ seconds remain before close". Counts are 2–4: entry 1 always exists
// (joining a challenge IS submitting a photo — there is no separate join
// flow), and GuruShots challenges allow at most 4 images, so the schedule is
// at most three rows (images 2, 3, 4). Counts must be unique (each target
// needs exactly one threshold); row order is irrelevant at runtime (the
// trigger is max-based) and the runtime additionally clamps to the live
// max_photo_submits as a safety net. The seconds cap is defense-in-depth
// against a corrupted settings file or out-of-band write, same rationale as
// the tagsList caps below.
const MAX_SCHEDULE_ROWS = 3;
// Mirrored in services/scheduleRemap.js (renderer-bundle-safe module that
// can't import this zod-carrying file) — change both together.
const MAX_SCHEDULE_COUNT = 4;
const MAX_SCHEDULE_SECONDS = 30 * 24 * 3600; // 30 days
// Seconds-after-start / seconds-before-end condition of a currency rule. 0 = that
// condition is off. Capped like every other duration.
const currencyRuleSec = z.number().int().min(0).max(MAX_SCHEDULE_SECONDS);
// Final-window duration (seconds before close during which the final-window
// exposure rule applies). Integer, at least 60s (a shorter window is
// meaningless against poll cadence) and capped by the same 30-day schedule
// ceiling as every other duration. Default is 3600 (the legacy fixed hour).
const finalWindowDurationSec = z.number().int().min(60).max(MAX_SCHEDULE_SECONDS);
const fillScheduleRow = z
    .object({
        count: z.number().int().min(2).max(MAX_SCHEDULE_COUNT),
        seconds: z.number().int().min(0).max(MAX_SCHEDULE_SECONDS),
    })
    .strict();
const fillSchedule = z
    .array(fillScheduleRow)
    .max(MAX_SCHEDULE_ROWS)
    .refine((rows) => new Set(rows.map((r) => r.count)).size === rows.length);

/**
 * Clamp a persisted autoFillSchedule array to the current bounds. Used by the
 * load-time `_autoFillScheduleBoundsV1` sanitizer in settings.js: the Settings
 * modal resubmits EVERY persisted key on save, so a stored schedule that
 * violates the (tightened) validator would block saving unrelated settings
 * until repaired — this heals such data on load instead. Keeps only strict
 * { count, seconds } rows within bounds, dedupes by count (first wins), and
 * sorts by count. Returns the sanitized array when anything changed, or null
 * when the input already conforms (or isn't an array at all — non-array
 * corruption is the read path's concern, mirroring getValidScheduleRows).
 *
 * @param {*} value
 * @returns {Array<{count: number, seconds: number}>|null}
 */
const sanitizeFillSchedule = (value) => {
    if (!Array.isArray(value)) return null;
    /** @type {Set<number>} */
    const seen = new Set();
    const normalized = value
        .filter((row) => {
            if (!row || typeof row !== 'object') return false;
            if (!Number.isInteger(row.count) || row.count < 2 || row.count > MAX_SCHEDULE_COUNT) return false;
            if (!Number.isInteger(row.seconds) || row.seconds < 0 || row.seconds > MAX_SCHEDULE_SECONDS) return false;
            if (seen.has(row.count)) return false;
            seen.add(row.count);
            return true;
        })
        .sort((a, b) => a.count - b.count)
        .map((row) => ({ count: row.count, seconds: row.seconds }));
    const unchanged =
        normalized.length === value.length &&
        normalized.every((row, i) => {
            const orig = value[i];
            return (
                orig &&
                typeof orig === 'object' &&
                orig.count === row.count &&
                orig.seconds === row.seconds &&
                Object.keys(orig).length === 2
            );
        });
    return unchanged ? null : normalized;
};

// Per-string and total-array caps for tag-list settings. A typical use is
// a few words per tag, a handful of tags per challenge — the caps exist
// to keep a corrupted settings file or out-of-band write from passing
// pathological input to the picker. Each tag must be a non-empty,
// non-whitespace string of at most MAX_TAG_LENGTH characters.
const MAX_TAG_LENGTH = 50;
const MAX_TAGS_PER_LIST = 50;
const tagsList = z
    .array(
        z
            .string()
            .min(1)
            .max(MAX_TAG_LENGTH)
            .refine((v) => v.trim().length > 0),
    )
    .max(MAX_TAGS_PER_LIST);

// Scheduled fill: LISTS of triggers (issue #26 follow-up — "fill twice in a
// day, like 4 hours to the end and 10 hours to the end"). Each entry opens
// its own fill window; the empty array is the off sentinel and the schema
// default (the old scalar '' / 0 sentinels are migrated in settings.js —
// _scheduledFillListsMigratedV1). Entries are deduped by the validators and
// canonical-sorted by the sanitizers; order carries no meaning. The window
// floor keeps a window from being shorter than one last-minute check cycle;
// the 12h ceiling keeps "hold at 100%" from silently becoming an all-day
// threshold override. Entry-level messages are surfaced verbatim by
// getValidationError (CLI settings:set feedback).
const MAX_BEFORE_END_SECONDS = MAX_SCHEDULE_SECONDS; // same 30-day defense-in-depth cap
const timeOfDayEntry = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected 24h HH:MM');
const timeOfDayList = z
    .array(timeOfDayEntry)
    .max(MAX_SCHEDULED_FILL_ENTRIES, `at most ${MAX_SCHEDULED_FILL_ENTRIES} times`)
    .refine((v) => new Set(v).size === v.length, 'duplicate times');
const beforeEndEntry = z.number().int().min(1).max(MAX_BEFORE_END_SECONDS);
const beforeEndList = z
    .array(beforeEndEntry)
    .max(MAX_SCHEDULED_FILL_ENTRIES, `at most ${MAX_SCHEDULED_FILL_ENTRIES} offsets`)
    .refine((v) => new Set(v).size === v.length, 'duplicate offsets');
const windowMinutes = z.number().int().min(5).max(720);
// Same shape for the pause, but bound to the shared constant the decision path
// clamps against, so the validator and the runtime ceiling can't drift apart.
const pauseDurationMinutes = z.number().int().min(5).max(MAX_VOTING_PAUSE_MINUTES);
// The voting-pause group reuses all four validators above verbatim: its
// triggers are the same two forms (daily 'HH:MM' + seconds-before-close), it
// shares MAX_SCHEDULED_FILL_ENTRIES, and its duration has the same 5m..12h
// bounds as a fill window. The ONLY difference is what the window does —
// scheduled fill votes inside it, the pause refuses to. Keep them sharing
// these validators so the two features can never drift on bounds or messages.

/**
 * Clamp a persisted scheduledFillTime list to the current bounds — the
 * sanitizeFillSchedule contract: healed array when anything changed, null
 * when the input already conforms or isn't an array at all. Keeps strict
 * 'HH:MM' strings, dedupes (first wins), sorts (lexicographic == chronological
 * for zero-padded 24h times) and THEN caps, so with >MAX entries the earliest
 * survive deterministically rather than storage order. Deliberately unhealed
 * gap (same accepted-risk class the scalar era carried): a value that is
 * neither string, number, nor array (`true`/`{}`/null from a hand edit) is
 * left as-is — the modal's resubmit path rejects it with the zod message
 * rather than saving.
 *
 * @param {*} value
 * @returns {string[]|null}
 */
const sanitizeTimeOfDayList = (value) => {
    if (!Array.isArray(value)) return null;
    const seen = new Set();
    const normalized = value
        .filter((entry) => {
            if (typeof entry !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(entry)) return false;
            if (seen.has(entry)) return false;
            seen.add(entry);
            return true;
        })
        .sort()
        .slice(0, MAX_SCHEDULED_FILL_ENTRIES);
    const unchanged = normalized.length === value.length && normalized.every((entry, i) => entry === value[i]);
    return unchanged ? null : normalized;
};

/**
 * Same contract for the scheduledFillBeforeEnd list: keep ints
 * 1..MAX_BEFORE_END_SECONDS, dedupe, sort ascending, then cap (smallest
 * offsets — the windows closest to the deadline — survive deterministically).
 *
 * @param {*} value
 * @returns {number[]|null}
 */
const sanitizeBeforeEndList = (value) => {
    if (!Array.isArray(value)) return null;
    const seen = new Set();
    const normalized = value
        .filter((entry) => {
            if (!Number.isInteger(entry) || entry < 1 || entry > MAX_BEFORE_END_SECONDS) return false;
            if (seen.has(entry)) return false;
            seen.add(entry);
            return true;
        })
        .sort((a, b) => a - b)
        .slice(0, MAX_SCHEDULED_FILL_ENTRIES);
    const unchanged = normalized.length === value.length && normalized.every((entry, i) => entry === value[i]);
    return unchanged ? null : normalized;
};

// Entries are grouped by their `group` field (see SETTINGS_GROUPS below) and
// declared in group order so the file reads top-to-bottom the way the
// settings modals render. Object key order has no runtime effect —
// getSchemaDefault resolves at call time and validationOrder/dependsOn drive
// dependency ordering — so the order here is purely for readability.
/** @type {Record<string, SettingsSchemaEntry>} */
const SETTINGS_SCHEMA = {
    // --- General ---
    // NOTE on min/max/unit: the IPC schema projection and SettingInput have always
    // forwarded these three fields, but no entry ever defined them — so every number input
    // rendered unbounded and unlabelled, and the only feedback for an out-of-range value was
    // a generic "could not be saved" banner. They mirror the zod validator directly; keep the
    // two in step when either changes.
    exposure: {
        type: 'number',
        default: 100,
        perChallenge: true,
        validation: percentage,
        min: 1,
        max: 100,
        unit: 'app.unitPercent',
        validationOrder: 1, // Validate first (no dependencies)
        group: 'general',
        label: 'app.exposure',
        description: 'app.exposureDesc',
    },
    exposureTarget: {
        type: 'number',
        // 0 is a sentinel meaning "vote up to the exposure trigger value" (legacy behavior).
        // Any 1-100 explicitly overrides the target so the loop keeps voting past the trigger.
        default: 0,
        perChallenge: true,
        validation: percentageOrZero,
        min: 0,
        max: 100,
        unit: 'app.unitPercent',
        contextValidation: (value, allSettings) => {
            if (value === 0) return true; // sentinel — always ok
            return value >= effectiveExposureOf(allSettings);
        },
        getContextError: (value, allSettings) =>
            `VALIDATION_GREATER_OR_EQUAL|app.exposure|${effectiveExposureOf(allSettings)}`,
        dependsOn: ['exposure'],
        validationOrder: 2, // Validate after dependencies
        group: 'general',
        label: 'app.exposureTarget',
        description: 'app.exposureTargetDesc',
        helpKey: 'app.exposureTargetHelp',
    },
    onlyBoost: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1, // Validate first (no dependencies)
        group: 'general',
        label: 'app.onlyBoost',
        description: 'app.onlyBoostDesc',
    },
    voteOnNewEntry: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'general',
        label: 'app.voteOnNewEntry',
        description: 'app.voteOnNewEntryDesc',
    },
    compactCards: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        // Display-only: it changes how the challenge card is drawn, not how the
        // challenge is voted, so it sits in the `display` group rather than
        // among the exposure knobs it used to be listed beside.
        group: 'display',
        label: 'app.compactCards',
        description: 'app.compactCardsDesc',
    },

    // --- Boost ---
    autoBoost: {
        type: 'boolean',
        default: true,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'boost',
        label: 'app.autoBoost',
        description: 'app.autoBoostDesc',
    },
    boostTime: {
        type: 'time', // Special type for hours/minutes input
        default: 3600, // 1 hour in seconds
        perChallenge: true,
        validation: nonNegNumber,
        validationOrder: 1, // Validate first (no dependencies)
        group: 'boost',
        label: 'app.boostTime',
        description: 'app.boostTimeDesc',
        helpKey: 'app.boostTimeHelp',
    },
    // Pre-boost exposure fill: for the configured lead before an available boost is
    // auto-applied, vote the challenge to 100% so the boost lands on a fully exposed
    // entry instead of a decayed one. Same two-setting shape as voteBeforeFinalWindow
    // (opt-in + lead minutes), and the scheduler caps its sleep to the window start so
    // a cycle actually lands inside it.
    voteBeforeBoost: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1, // Validate first (no dependencies)
        group: 'boost',
        label: 'app.voteBeforeBoost',
        description: 'app.voteBeforeBoostDesc',
        helpKey: 'app.voteBeforeBoostHelp',
    },
    // Lead minutes before the boost-apply instant during which the fill runs. Reuses
    // the 1..59 minute validator; 0 is intentionally not allowed (a zero-width window
    // would never contain a cycle, silently disabling the feature). Exposure does not
    // jump to 100% in a single pass, so the default leaves room for several cycles at
    // the normal cadence.
    voteBeforeBoostLeadMin: {
        type: 'number',
        default: 15,
        perChallenge: true,
        validation: minute1to59,
        min: 1,
        max: 59,
        unit: 'app.unitMinutes',
        validationOrder: 1, // Validate first (no dependencies)
        group: 'boost',
        label: 'app.voteBeforeBoostLeadMin',
        description: 'app.voteBeforeBoostLeadMinDesc',
    },
    // Deliberately separate from boostTime, not a replacement for it. The two describe
    // different clocks: boostTime counts down the boost's OWN timer, while a key-unlocked
    // boost has no timer at all and can only be measured against the challenge's close time.
    // Reusing boostTime for both would silently reinterpret one user-facing number as two
    // different things. Default 900s (15m) preserves the behaviour of the constant it
    // replaces — key-unlocked boosts never expire, so spending one late maximises its effect.
    keyUnlockedBoostTime: {
        type: 'time', // hours/minutes input, stored as seconds
        default: 900, // 15 minutes in seconds
        perChallenge: true,
        validation: nonNegNumber,
        validationOrder: 1,
        group: 'boost',
        label: 'app.keyUnlockedBoostTime',
        description: 'app.keyUnlockedBoostTimeDesc',
        helpKey: 'app.keyUnlockedBoostTimeHelp',
    },
    boostImageIndex: {
        type: 'number',
        default: 1,
        perChallenge: true,
        validation: entrySlotIndex,
        min: 0,
        max: MAX_ENTRY_SLOT,
        validationOrder: 1,
        group: 'boost',
        label: 'app.boostImageIndex',
        description: 'app.boostImageIndexDesc',
    },
    boostFillNew: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'boost',
        label: 'app.boostFillNew',
        description: 'app.boostFillNewDesc',
    },
    boostFillNewOnConflict: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'boost',
        label: 'app.boostFillNewOnConflict',
        description: 'app.boostFillNewOnConflictDesc',
    },

    // --- Turbo ---
    useTurbo: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'turbo',
        label: 'app.useTurbo',
        description: 'app.useTurboDesc',
    },
    autoTurbo: {
        type: 'boolean',
        default: true,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'turbo',
        label: 'app.autoTurbo',
        description: 'app.autoTurboDesc',
    },
    turboTime: {
        type: 'time',
        default: 7200, // 2 hours in seconds
        perChallenge: true,
        validation: nonNegNumber,
        validationOrder: 1,
        group: 'turbo',
        label: 'app.turboTime',
        description: 'app.turboTimeDesc',
        helpKey: 'app.turboTimeHelp',
    },
    turboImageIndex: {
        type: 'number',
        default: 1,
        perChallenge: true,
        validation: entrySlotIndex,
        min: 0,
        max: MAX_ENTRY_SLOT,
        validationOrder: 1,
        group: 'turbo',
        label: 'app.turboImageIndex',
        description: 'app.turboImageIndexDesc',
    },
    turboApplyWhenBoostActive: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'turbo',
        label: 'app.turboApplyWhenBoostActive',
        description: 'app.turboApplyWhenBoostActiveDesc',
    },
    turboFillNew: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'turbo',
        label: 'app.turboFillNew',
        description: 'app.turboFillNewDesc',
    },
    turboFillNewOnConflict: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'turbo',
        label: 'app.turboFillNewOnConflict',
        description: 'app.turboFillNewOnConflictDesc',
    },

    // --- Keys, Swaps & Fills (currency automation) ---
    // Automatic spending of the three bankroll currencies the manual card buttons
    // spend (services/currencyActions.js). Every per-challenge key here is
    // challengeOnly: there is deliberately NO global switch — automation is turned
    // on per challenge or per profile, so spending currency is always an explicit
    // choice. Each action has three optional timing conditions (after start, before
    // end, after % elapsed); every condition that is set must hold (0 = that
    // condition off, family-1 sentinel), and none set means "any time". The pure
    // rule math lives in voting/currencyAuto.js.
    autoKeyUnlock: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        challengeOnly: true,
        validation: zBool,
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoKeyUnlock',
        description: 'app.autoKeyUnlockDesc',
    },
    autoKeyAfterStart: {
        type: 'time',
        default: 0,
        perChallenge: true,
        challengeOnly: true,
        validation: currencyRuleSec,
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoKeyAfterStart',
        description: 'app.autoKeyAfterStartDesc',
        helpKey: 'app.currencyRuleTimingHelp',
    },
    autoKeyBeforeEnd: {
        type: 'time',
        default: 0,
        perChallenge: true,
        challengeOnly: true,
        validation: currencyRuleSec,
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoKeyBeforeEnd',
        description: 'app.autoKeyBeforeEndDesc',
        helpKey: 'app.currencyRuleTimingHelp',
    },
    autoKeyAfterPercent: {
        type: 'number',
        default: 0,
        perChallenge: true,
        challengeOnly: true,
        validation: joinPercentElapsed,
        min: 0,
        max: MAX_JOIN_PERCENT_ELAPSED,
        unit: 'app.unitPercent',
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoKeyAfterPercent',
        description: 'app.autoKeyAfterPercentDesc',
        helpKey: 'app.currencyRuleTimingHelp',
    },
    autoSwap: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        challengeOnly: true,
        validation: zBool,
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoSwap',
        description: 'app.autoSwapDesc',
    },
    autoSwapAfterStart: {
        type: 'time',
        default: 0,
        perChallenge: true,
        challengeOnly: true,
        validation: currencyRuleSec,
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoSwapAfterStart',
        description: 'app.autoSwapAfterStartDesc',
        helpKey: 'app.currencyRuleTimingHelp',
    },
    autoSwapBeforeEnd: {
        type: 'time',
        default: 0,
        perChallenge: true,
        challengeOnly: true,
        validation: currencyRuleSec,
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoSwapBeforeEnd',
        description: 'app.autoSwapBeforeEndDesc',
        helpKey: 'app.currencyRuleTimingHelp',
    },
    autoSwapAfterPercent: {
        type: 'number',
        default: 0,
        perChallenge: true,
        challengeOnly: true,
        validation: joinPercentElapsed,
        min: 0,
        max: MAX_JOIN_PERCENT_ELAPSED,
        unit: 'app.unitPercent',
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoSwapAfterPercent',
        description: 'app.autoSwapAfterPercentDesc',
        helpKey: 'app.currencyRuleTimingHelp',
    },
    // Which entry a swap replaces: 1-4 = that slot, 0 = the last entry — the same
    // convention as boostImageIndex / turboImageIndex.
    autoSwapImageIndex: {
        type: 'number',
        default: 0,
        perChallenge: true,
        challengeOnly: true,
        validation: entrySlotIndex,
        min: 0,
        max: MAX_ENTRY_SLOT,
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoSwapImageIndex',
        description: 'app.autoSwapImageIndexDesc',
    },
    autoSwapLowestVotes: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        challengeOnly: true,
        validation: zBool,
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoSwapLowestVotes',
        description: 'app.autoSwapLowestVotesDesc',
    },
    autoSwapAllowBoosted: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        challengeOnly: true,
        validation: zBool,
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoSwapAllowBoosted',
        description: 'app.autoSwapAllowBoostedDesc',
    },
    autoSwapMaxVotes: {
        type: 'number',
        default: 0,
        perChallenge: true,
        challengeOnly: true,
        validation: swapVoteCeiling,
        min: 0,
        max: MAX_SWAP_VOTE_CEILING,
        unit: 'app.unitVotes',
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoSwapMaxVotes',
        description: 'app.autoSwapMaxVotesDesc',
    },
    autoSwapMax: {
        type: 'number',
        default: 1,
        perChallenge: true,
        challengeOnly: true,
        validation: autoSpendCount,
        min: 1,
        max: MAX_AUTO_SPENDS_PER_CHALLENGE,
        unit: 'app.unitSwaps',
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoSwapMax',
        description: 'app.autoSwapMaxDesc',
    },
    autoExposureFill: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        challengeOnly: true,
        validation: zBool,
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoExposureFill',
        description: 'app.autoExposureFillDesc',
    },
    // A fill is worth exactly what voting is worth, so it only runs when voting
    // cannot do the job: exposure is below this AND the vote pool cannot lift it
    // back to this (typically a flash challenge that has run out of photos to vote).
    autoExposureFillBelow: {
        type: 'number',
        default: 50,
        perChallenge: true,
        challengeOnly: true,
        validation: percentage,
        min: 1,
        max: 100,
        unit: 'app.unitPercent',
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoExposureFillBelow',
        description: 'app.autoExposureFillBelowDesc',
    },
    autoExposureFillAfterStart: {
        type: 'time',
        default: 0,
        perChallenge: true,
        challengeOnly: true,
        validation: currencyRuleSec,
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoExposureFillAfterStart',
        description: 'app.autoExposureFillAfterStartDesc',
        helpKey: 'app.currencyRuleTimingHelp',
    },
    autoExposureFillBeforeEnd: {
        type: 'time',
        default: 0,
        perChallenge: true,
        challengeOnly: true,
        validation: currencyRuleSec,
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoExposureFillBeforeEnd',
        description: 'app.autoExposureFillBeforeEndDesc',
        helpKey: 'app.currencyRuleTimingHelp',
    },
    autoExposureFillAfterPercent: {
        type: 'number',
        default: 0,
        perChallenge: true,
        challengeOnly: true,
        validation: joinPercentElapsed,
        min: 0,
        max: MAX_JOIN_PERCENT_ELAPSED,
        unit: 'app.unitPercent',
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoExposureFillAfterPercent',
        description: 'app.autoExposureFillAfterPercentDesc',
        helpKey: 'app.currencyRuleTimingHelp',
    },
    autoExposureFillMax: {
        type: 'number',
        default: 1,
        perChallenge: true,
        challengeOnly: true,
        validation: autoSpendCount,
        min: 1,
        max: MAX_AUTO_SPENDS_PER_CHALLENGE,
        unit: 'app.unitFills',
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoExposureFillMax',
        description: 'app.autoExposureFillMaxDesc',
    },
    // Global reserve (not per challenge): automation never spends the balance
    // below this. Manual spends from the card are not limited by it.
    currencyReserveKeys: {
        type: 'number',
        default: 0,
        perChallenge: false,
        validation: currencyReserve,
        min: 0,
        max: MAX_CURRENCY_RESERVE,
        unit: 'app.unitKeys',
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.currencyReserveKeys',
        description: 'app.currencyReserveKeysDesc',
    },
    // Global reserve (not per challenge): automation never spends the balance
    // below this. Manual spends from the card are not limited by it.
    currencyReserveSwaps: {
        type: 'number',
        default: 0,
        perChallenge: false,
        validation: currencyReserve,
        min: 0,
        max: MAX_CURRENCY_RESERVE,
        unit: 'app.unitSwaps',
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.currencyReserveSwaps',
        description: 'app.currencyReserveSwapsDesc',
    },
    // Global reserve (not per challenge): automation never spends the balance
    // below this. Manual spends from the card are not limited by it.
    currencyReserveFills: {
        type: 'number',
        default: 0,
        perChallenge: false,
        validation: currencyReserve,
        min: 0,
        max: MAX_CURRENCY_RESERVE,
        unit: 'app.unitFills',
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.currencyReserveFills',
        description: 'app.currencyReserveFillsDesc',
    },

    // --- Final Window Exposure ---
    // Duration of the "final window" before a challenge closes during which the
    // final-window exposure rule applies. Default 3600s (1 hour) preserves the
    // legacy fixed one-hour behaviour; stored as seconds via the hours/minutes
    // input. Read per-challenge by the voting rules and the top-up scheduler.
    finalWindowDuration: {
        type: 'time', // hours/minutes input, stored as seconds
        default: 3600, // 1 hour in seconds
        perChallenge: true,
        validation: finalWindowDurationSec,
        min: 60,
        max: MAX_SCHEDULE_SECONDS,
        validationOrder: 1, // Validate first (no dependencies)
        group: 'finalWindow',
        label: 'app.finalWindowDuration',
        description: 'app.finalWindowDurationDesc',
        helpKey: 'app.finalWindowDurationHelp',
    },
    useFinalWindowExposure: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1, // Validate first (no dependencies)
        group: 'finalWindow',
        label: 'app.useFinalWindowExposure',
        description: 'app.useFinalWindowExposureDesc',
    },
    finalWindowExposure: {
        type: 'number',
        default: 100,
        perChallenge: true,
        validation: percentage,
        min: 1,
        max: 100,
        unit: 'app.unitPercent',
        // If exposure is not set or invalid, effectiveExposureOf falls back to
        // the exposure default for comparison.
        contextValidation: (value, allSettings) => value <= effectiveExposureOf(allSettings),
        // Return a string that the UI will translate
        getContextError: (value, allSettings) =>
            `VALIDATION_LESS_OR_EQUAL|app.exposure|${effectiveExposureOf(allSettings)}`,
        dependsOn: ['exposure'],
        validationOrder: 2, // Validate after dependencies
        group: 'finalWindow',
        label: 'app.finalWindowExposure',
        description: 'app.finalWindowExposureDesc',
    },
    finalWindowExposureTarget: {
        type: 'number',
        // 0 is a sentinel meaning "vote up to the finalWindowExposure trigger value" (legacy behavior).
        default: 0,
        perChallenge: true,
        validation: percentageOrZero,
        min: 0,
        max: 100,
        unit: 'app.unitPercent',
        contextValidation: (value, allSettings) => {
            if (value === 0) return true;
            const triggerValue = allSettings.finalWindowExposure;
            const effectiveTrigger =
                typeof triggerValue === 'number' && triggerValue >= 1 && triggerValue <= 100
                    ? triggerValue
                    : getSchemaDefault('finalWindowExposure');
            return value >= effectiveTrigger;
        },
        getContextError: (value, allSettings) => {
            const triggerValue = allSettings.finalWindowExposure;
            const effectiveTrigger =
                typeof triggerValue === 'number' && triggerValue >= 1 && triggerValue <= 100
                    ? triggerValue
                    : getSchemaDefault('finalWindowExposure');
            return `VALIDATION_GREATER_OR_EQUAL|app.finalWindowExposure|${effectiveTrigger}`;
        },
        dependsOn: ['finalWindowExposure'],
        validationOrder: 2,
        group: 'finalWindow',
        label: 'app.finalWindowExposureTarget',
        description: 'app.finalWindowExposureTargetDesc',
        helpKey: 'app.finalWindowExposureTargetHelp',
    },
    // Boolean toggle (0-is-off convention does NOT apply — this is a flag, not a
    // duration). Only meaningful alongside useFinalWindowExposure: it tops the
    // challenge up to the STANDARD exposure target across the boundary into the
    // final window, so a challenge whose exposure decayed below standard doesn't
    // get stranded there by the final-window rule's lower (recovery) trigger.
    voteBeforeFinalWindow: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1, // Validate first (no dependencies)
        group: 'finalWindow',
        label: 'app.voteBeforeFinalWindow',
        description: 'app.voteBeforeFinalWindowDesc',
    },
    // Lead minutes: half-width of the top-up window straddling the final-window
    // boundary — the window runs [close-finalWindowDuration-lead,
    // close-finalWindowDuration+lead], i.e. it starts `lead` minutes BEFORE the
    // final window (the scheduler wakes then to guarantee the top-up) and extends
    // `lead` minutes INTO it as a grace period for timing jitter / an app started
    // late. Reuses the 1..59 minute validator; 0 is intentionally not allowed (a
    // zero-width window would defeat the point).
    voteBeforeFinalWindowLeadMin: {
        type: 'number',
        default: 15,
        perChallenge: true,
        validation: minute1to59,
        min: 1,
        max: 59,
        unit: 'app.unitMinutes',
        validationOrder: 1, // Validate first (no dependencies)
        group: 'finalWindow',
        label: 'app.voteBeforeFinalWindowLeadMin',
        description: 'app.voteBeforeFinalWindowLeadMinDesc',
    },

    // --- Last Minute ---
    voteOnlyInLastMinute: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1, // Validate first (no dependencies)
        group: 'lastMinute',
        label: 'app.voteOnlyInLastMinute',
        description: 'app.voteOnlyInLastMinuteDesc',
    },
    lastMinuteThreshold: {
        type: 'number',
        default: 10,
        perChallenge: true,
        validation: minute1to59,
        min: 1,
        max: 59,
        unit: 'app.unitMinutes',
        validationOrder: 1, // Validate first (no dependencies)
        group: 'lastMinute',
        label: 'app.lastMinuteThreshold',
        description: 'app.lastMinuteThresholdDesc',
    },
    lastMinuteCheckFrequency: {
        type: 'number',
        default: 1,
        perChallenge: false,
        validation: minute1to59,
        min: 1,
        max: 59,
        unit: 'app.unitMinutes',
        validationOrder: 1, // Validate first (no dependencies)
        group: 'lastMinute',
        label: 'app.lastMinuteCheckFrequency',
        description: 'app.lastMinuteCheckFrequencyDesc',
    },

    // --- Scheduled Fill ---
    // Fill exposure at configured wall-clock instants instead of (or on top
    // of) the threshold rules. Two independent trigger LISTS — recurring
    // times-of-day (interpreted in the app `timezone` setting via
    // scheduling/wallClock.js, NOT device-local time) and one-shot
    // seconds-before-close offsets — every entry opens its own window sharing
    // scheduledFillWindowMinutes, all OR'd. The decision-side consumer is
    // getScheduledFillState in services/VotingLogic.js; the cadence-side
    // consumer is scheduling/scheduledFill.js.
    useScheduledFill: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'scheduledFill',
        label: 'app.useScheduledFill',
        description: 'app.useScheduledFillDesc',
    },
    scheduledFillTime: {
        type: 'timeOfDayList',
        default: [], // [] = this form off
        perChallenge: true,
        validation: timeOfDayList,
        validationOrder: 1,
        group: 'scheduledFill',
        label: 'app.scheduledFillTime',
        description: 'app.scheduledFillTimeDesc',
    },
    scheduledFillBeforeEnd: {
        type: 'timeList', // rows of hours/minutes inputs, stored as seconds each
        default: [], // [] = this form off
        perChallenge: true,
        validation: beforeEndList,
        validationOrder: 1,
        group: 'scheduledFill',
        label: 'app.scheduledFillBeforeEnd',
        description: 'app.scheduledFillBeforeEndDesc',
    },
    scheduledFillWindowMinutes: {
        type: 'number',
        default: 60,
        perChallenge: true,
        validation: windowMinutes,
        // 5 is the real floor: it is what saving enforces and what the CLI help documents.
        // getScheduledFillState still honours a smaller hand-edited value, which stays an
        // advanced escape hatch rather than something the UI will produce.
        min: 5,
        max: 720,
        unit: 'app.unitMinutes',
        validationOrder: 1,
        group: 'scheduledFill',
        label: 'app.scheduledFillWindowMinutes',
        description: 'app.scheduledFillWindowMinutesDesc',
    },
    scheduledFillReplaces: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'scheduledFill',
        label: 'app.scheduledFillReplaces',
        description: 'app.scheduledFillReplacesDesc',
    },

    // --- Voting Pause ---
    // The inverse of scheduled fill: windows in which automatic voting is
    // REFUSED rather than forced. Motivated by the overnight gap between match
    // rounds — exposure filled at 03:00 buys almost no votes, so the votes are
    // better spent after the morning round opens.
    //
    // Same two trigger forms, same lists-of-entries shape, same validators and
    // same entry cap as scheduled fill (see the validator block above), with
    // votingPauseDurationMinutes playing the scheduledFillWindowMinutes role.
    // The decision-side consumer is getVotingPauseState in
    // services/VotingLogic.js.
    //
    // Deliberately NOT a cadence input: the pass still runs on its normal
    // schedule during a pause and each paused challenge is skipped with a
    // reason. Suppressing the wake instead would have to out-rank every other
    // scheduling boundary (boost timers, last-minute cadence), which is the
    // one thing the scheduler's "never sleep past a boundary" invariant
    // forbids.
    useVotingPause: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'votingPause',
        label: 'app.useVotingPause',
        description: 'app.useVotingPauseDesc',
    },
    votingPauseTime: {
        type: 'timeOfDayList',
        default: [], // [] = this form off
        perChallenge: true,
        validation: timeOfDayList,
        validationOrder: 1,
        group: 'votingPause',
        label: 'app.votingPauseTime',
        description: 'app.votingPauseTimeDesc',
    },
    votingPauseBeforeEnd: {
        type: 'timeList', // rows of hours/minutes inputs, stored as seconds each
        default: [], // [] = this form off
        perChallenge: true,
        validation: beforeEndList,
        validationOrder: 1,
        group: 'votingPause',
        label: 'app.votingPauseBeforeEnd',
        description: 'app.votingPauseBeforeEndDesc',
    },
    votingPauseDurationMinutes: {
        type: 'number',
        default: 240,
        perChallenge: true,
        validation: pauseDurationMinutes,
        // 5 is the real floor (what saving enforces and what the CLI documents);
        // getVotingPauseState still honours a SMALLER hand-edited value, matching
        // scheduledFillWindowMinutes' escape hatch. The ceiling is NOT an escape
        // hatch though — getVotingPauseState clamps to it, because an oversized
        // pause window swallows every future cycle and stops voting for good.
        min: 5,
        max: MAX_VOTING_PAUSE_MINUTES,
        unit: 'app.unitMinutes',
        validationOrder: 1,
        group: 'votingPause',
        label: 'app.votingPauseDurationMinutes',
        description: 'app.votingPauseDurationMinutesDesc',
    },

    // --- Auto Join ---
    // Enable for the automatic join pre-step (runs each voting cycle on every
    // platform). Default off, but resolved master → profile → per-challenge, so a
    // title profile can turn it on for its title. Scope below decides WHICH open
    // challenges are joined; the coin caps gate paid ones.
    //
    // NOTE: the former `autoJoinAll` boolean was removed. The scope model is now
    // "default = all types" narrowed by autoJoinTypes; enabling autoJoin therefore
    // joins ALL open (free) challenges unless a type list narrows it. Paid stays
    // gated by the coin caps below (0 = free only), so no unintended spend. An
    // orphaned autoJoinAll value in an old settings file is inert (never read;
    // pruned by cleanupObsoleteSettings).
    autoJoin: {
        type: 'boolean',
        default: false,
        // Per-challenge/title-profile overridable: the master value is just the
        // default. A title profile (or per-challenge override) can enable joining
        // for its title even when the master is off — master → profile → challenge.
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'autoJoin',
        label: 'app.autoJoin',
        description: 'app.autoJoinDesc',
    },
    // Scope: comma-separated challenge types to join (e.g. "flash,contest").
    // EMPTY = all types (the default once auto-join is on). A title matching a
    // saved profile is always in scope regardless of this.
    autoJoinTypes: {
        type: 'string',
        default: '',
        perChallenge: true,
        validation: zString,
        validationOrder: 1,
        group: 'autoJoin',
        label: 'app.autoJoinTypes',
        description: 'app.autoJoinTypesDesc',
    },
    // Comma-separated challenge types to NEVER auto-join. Subtracts from the
    // (default-all) scope, so leaving types empty + excluding "flash,exhibition"
    // joins everything except those.
    autoJoinExcludeTypes: {
        type: 'string',
        default: '',
        perChallenge: true,
        validation: zString,
        validationOrder: 1,
        group: 'autoJoin',
        label: 'app.autoJoinExcludeTypes',
        description: 'app.autoJoinExcludeTypesDesc',
    },
    // Scope by the challenge's OWN tags — the API-supplied classifiers on each
    // challenge ("Exhibition", "Comm", "No comm", "Turbo", "Magazine",
    // "special 4 pic"). These are NOT the photo tags of mustIncludeTags /
    // shouldIncludeTags: those pick which of YOUR photos to submit, these pick
    // which CHALLENGES to join. Same shape as the type lists above: empty
    // include = all, exclude subtracts, a title opt-in bypasses both.
    autoJoinChallengeTags: {
        type: 'string',
        default: '',
        perChallenge: true,
        validation: zString,
        validationOrder: 1,
        group: 'autoJoin',
        label: 'app.autoJoinChallengeTags',
        description: 'app.autoJoinChallengeTagsDesc',
    },
    autoJoinExcludeChallengeTags: {
        type: 'string',
        default: '',
        perChallenge: true,
        validation: zString,
        validationOrder: 1,
        group: 'autoJoin',
        label: 'app.autoJoinExcludeChallengeTags',
        description: 'app.autoJoinExcludeChallengeTagsDesc',
    },
    // Join-timing gate: only join a candidate once it is within this many hours
    // of its close_time. 0 = off (join as soon as the candidate is seen — the
    // historical behavior), so this is the "0 = feature off" sentinel family,
    // NOT the exposureTarget "0 = same as trigger" one.
    //
    // FAIL-CLOSED: while this is above 0, a candidate whose close_time cannot be
    // read is NOT joined (see VotingLogic.shouldJoinChallenge). An un-joined
    // candidate that never proves it is inside the window must not be joined by
    // default — that would spend the entry (and possibly coins) at exactly the
    // moment the user asked to avoid. The live payload does carry close_time on
    // every open challenge (verified 2026-09-19), so this guards against the
    // field going away upstream, not against the normal case.
    autoJoinWithinHoursOfEnd: {
        type: 'number',
        default: 0,
        perChallenge: true,
        validation: joinWindowHours,
        min: 0,
        max: MAX_JOIN_WINDOW_HOURS,
        unit: 'app.unitHours',
        validationOrder: 1,
        group: 'autoJoin',
        label: 'app.autoJoinWithinHoursOfEnd',
        description: 'app.autoJoinWithinHoursOfEndDesc',
        helpKey: 'app.autoJoinWithinHoursOfEndHelp',
    },
    // Elapsed-fraction join anchor. 0 = off. When BOTH this and
    // autoJoinWithinHoursOfEnd are set on the same resolved source, the percent
    // wins (see resolveJoinWindow in services/VotingLogic.js) — one candidate
    // gets ONE window, never the intersection of two, so the effective timing is
    // always readable off a single number.
    //
    // FAIL-CLOSED exactly like the hours window, and on one more field: percent
    // mode needs start_time AND close_time to know the challenge's length, so a
    // candidate missing either is deferred rather than joined.
    autoJoinAfterPercentElapsed: {
        type: 'number',
        default: 0,
        perChallenge: true,
        validation: joinPercentElapsed,
        min: 0,
        max: MAX_JOIN_PERCENT_ELAPSED,
        unit: 'app.unitPercent',
        validationOrder: 1,
        group: 'autoJoin',
        label: 'app.autoJoinAfterPercentElapsed',
        description: 'app.autoJoinAfterPercentElapsedDesc',
        helpKey: 'app.autoJoinAfterPercentElapsedHelp',
    },
    // Per-challenge coin cap. 0 = free only (paid joins disabled). Paid joining
    // requires BOTH this AND autoJoinCycleCoinBudget > 0.
    autoJoinMaxCoins: {
        type: 'number',
        default: 0,
        perChallenge: true,
        validation: coinAmount,
        min: 0,
        max: MAX_COIN_AMOUNT,
        unit: 'app.unitCoins',
        validationOrder: 1,
        group: 'autoJoin',
        label: 'app.autoJoinMaxCoins',
        description: 'app.autoJoinMaxCoinsDesc',
    },
    // Total coins the auto-join pass may spend in ONE cycle. 0 = spend nothing
    // this cycle (paid disabled). Global safety guard against burning the
    // balance across many candidates in a single pass.
    autoJoinCycleCoinBudget: {
        type: 'number',
        default: 0,
        perChallenge: false,
        validation: coinAmount,
        min: 0,
        max: MAX_COIN_AMOUNT,
        unit: 'app.unitCoins',
        validationOrder: 1,
        group: 'autoJoin',
        label: 'app.autoJoinCycleCoinBudget',
        description: 'app.autoJoinCycleCoinBudgetDesc',
    },

    // --- Auto Fill ---
    autoFill: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.autoFill',
        description: 'app.autoFillDesc',
    },
    // Replaces the old autoFillIntervalMinutes single-interval knob (migrated
    // in settings.js `_autoFillScheduleMigratedV1`). Default mirrors the old
    // 10-minute default: 2 @ 30m, 3 @ 20m, 4 @ 10m before close.
    autoFillSchedule: {
        type: 'schedule',
        default: [
            { count: 2, seconds: 1800 },
            { count: 3, seconds: 1200 },
            { count: 4, seconds: 600 },
        ],
        perChallenge: true,
        validation: fillSchedule,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.autoFillSchedule',
        description: 'app.autoFillScheduleDesc',
    },
    fillWithoutTagMatch: {
        type: 'boolean',
        default: true,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.fillWithoutTagMatch',
        description: 'app.fillWithoutTagMatchDesc',
    },
    // Emergency fill only acts on scheduler cycles that actually run, so it
    // depends on cadence: keep emergencyFill <= lastMinuteThreshold and the
    // fast last-minute cron is already active throughout the window. If it is
    // larger, the early part of the window relies on the slower normal cadence
    // (it still fires, just less tightly) — see emergencyFillDesc.
    emergencyFill: {
        type: 'time', // Special type for hours/minutes input (stored as seconds)
        default: 300, // 5 minutes in seconds
        perChallenge: true,
        // 0 is the off sentinel; otherwise seconds-before-close (mirrors boostTime/turboTime).
        validation: nonNegNumber,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.emergencyFill',
        description: 'app.emergencyFillDesc',
        helpKey: 'app.emergencyFillHelp',
    },
    mustIncludeTags: {
        type: 'tags',
        default: [],
        perChallenge: true,
        validation: tagsList,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.mustIncludeTags',
        description: 'app.mustIncludeTagsDesc',
    },
    shouldIncludeTags: {
        type: 'tags',
        default: [],
        perChallenge: true,
        validation: tagsList,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.shouldIncludeTags',
        description: 'app.shouldIncludeTagsDesc',
    },
    // Words to drop from a challenge TITLE before it is used as a theme.
    //
    // Challenge titles qualify their subject rather than just naming it — "Epic
    // Lighthouses", "Dramatic Storms", "Captivating Macro". The qualifier is not
    // a subject: it dilutes the pooled theme vector and, because only
    // SEARCH_TERMS_CAP terms are searched, it can push the real subject out
    // entirely. The series prefix in "Color Hunt: Green" is handled structurally
    // (see titleSubject in services/photoPicker.js) and needs no entry here.
    //
    // Seeded rather than hardcoded on purpose: every word is visible and
    // removable. Delete one if a challenge genuinely IS about it — "Negative
    // Space" is a real photographic subject, which is why "negative" is not in
    // this list.
    ignoreTitleWords: {
        type: 'tags',
        default: [
            'epic',
            'dramatic',
            'captivating',
            'fascinating',
            'powerful',
            'beautiful',
            'amazing',
            'stunning',
            'incredible',
            'breathtaking',
            'gorgeous',
            'glorious',
            'spectacular',
            'magical',
            'majestic',
            'striking',
            'wonderful',
            'awesome',
            'lovely',
            'perfect',
            'ultimate',
            'extreme',
            'favorite',
            'favourite',
            'melodic',
            'little',
            'creative',
            'creatively',
        ],
        perChallenge: true,
        validation: tagsList,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.ignoreTitleWords',
        description: 'app.ignoreTitleWordsDesc',
    },

    // --- Rewards ---
    // Claim finished-challenge rewards and completed-mission prizes
    // automatically. GLOBAL and default OFF; the pass runs as a pre-step of the
    // voting cycle but at most once an hour (services/autoClaim.js).
    autoClaimPrizes: {
        type: 'boolean',
        default: false,
        perChallenge: false,
        validation: zBool,
        validationOrder: 1,
        group: 'rewards',
        label: 'app.autoClaimPrizes',
        description: 'app.autoClaimPrizesDesc',
    },

    // --- Notifications ---
    // OS desktop/mobile "action coming up" warnings. All GLOBAL (perChallenge:
    // false) and default OFF — entirely opt-in. Each toggle gates one deadline
    // action type; notifyLeadTime is how far ahead the warning fires. The
    // decision + delivery live in services/deadlineNotifications.js + the
    // per-host notify adapters. Only the enabled types are ever evaluated, so
    // an all-off config (the default) costs nothing per cycle.
    notifyOnBoost: {
        type: 'boolean',
        default: false,
        perChallenge: false,
        validation: zBool,
        validationOrder: 1,
        group: 'notifications',
        label: 'app.notifyOnBoost',
        description: 'app.notifyOnBoostDesc',
    },
    notifyOnTurbo: {
        type: 'boolean',
        default: false,
        perChallenge: false,
        validation: zBool,
        validationOrder: 1,
        group: 'notifications',
        label: 'app.notifyOnTurbo',
        description: 'app.notifyOnTurboDesc',
    },
    notifyOnAutoFill: {
        type: 'boolean',
        default: false,
        perChallenge: false,
        validation: zBool,
        validationOrder: 1,
        group: 'notifications',
        label: 'app.notifyOnAutoFill',
        description: 'app.notifyOnAutoFillDesc',
    },
    notifyOnEmergencyFill: {
        type: 'boolean',
        default: false,
        perChallenge: false,
        validation: zBool,
        validationOrder: 1,
        group: 'notifications',
        label: 'app.notifyOnEmergencyFill',
        description: 'app.notifyOnEmergencyFillDesc',
    },
    notifyLeadTime: {
        type: 'number',
        default: 5,
        perChallenge: false,
        validation: notifyLeadMinutes,
        min: 1,
        max: 60,
        unit: 'app.unitMinutes',
        validationOrder: 1,
        group: 'notifications',
        label: 'app.notifyLeadTime',
        description: 'app.notifyLeadTimeDesc',
        // Best-effort caveat: the app can only warn on a cycle it actually
        // runs, so a lead longer than the check cadence near a deadline may
        // arrive with little real lead. Surfaced so the setting can't silently
        // over-promise (see docs / plan honest-limitation).
        helpKey: 'app.notifyLeadTimeHelp',
    },

    // --- Internal (no UI group; never rendered in a settings section) ---
    // Persisted autovote-running flag. Written on Start / Stop so a
    // relaunch of the app (Capacitor WebView destroyed + recreated,
    // Electron window reopen) can resume voting without the user
    // tapping Start again.
    autovoteRunning: {
        type: 'boolean',
        default: false,
        perChallenge: false,
        validation: zBool,
        validationOrder: 1,
        label: 'app.autovoteRunning',
        description: 'app.autovoteRunningDesc',
    },
    // Update version the user chose to skip. Electron persists this in
    // metadata.json (fs); the Android/Capacitor bridge has no fs, so it
    // routes skip-update-version through the settings facade instead, which
    // has a platform-agnostic transport (@capacitor/preferences). Empty
    // string means "nothing skipped".
    skipUpdateVersion: {
        type: 'string',
        default: '',
        perChallenge: false,
        validation: zString,
        validationOrder: 1,
        label: 'app.skipUpdateVersion',
        description: 'app.skipUpdateVersionDesc',
    },
};

/**
 * Ordered tiers the groups below are rendered under. A tier is presentation
 * only — nothing branches on it — but the order encodes the rule the section
 * list follows: settings a user always touches come before ones that only
 * matter once a specific feature is switched on.
 *
 * - `core`      — on by default, or the value everyone edits first.
 * - `entries`   — what gets submitted into a challenge (photos, joins).
 * - `overrides` — timing rules that replace the normal exposure decision.
 *                 Every enable flag in this tier defaults to false.
 * - `app`       — application-level preferences, not voting behaviour.
 *
 * @type {ReadonlyArray<{ id: string, label: string }>}
 */
const SETTINGS_TIERS = [
    { id: 'core', label: 'app.tierCore' },
    { id: 'entries', label: 'app.tierEntries' },
    { id: 'overrides', label: 'app.tierOverrides' },
    { id: 'app', label: 'app.tierApp' },
];

/**
 * Ordered UI grouping for the settings modals. Each schema entry's `group`
 * field matches an `id` here; the modals render one static section per group
 * in this order, banded under its `tier` (see SETTINGS_TIERS). Entries with no
 * `group` (e.g. autovoteRunning) are intentionally excluded from every section.
 *
 * Group ids are persisted-adjacent — `getGroupApplicability` switches on them
 * and tests assert on them — so ordering and labels change here freely, but an
 * id does not. In particular `scheduledFill` keeps its id while its labels now
 * read "Scheduled Voting": it is an exposure-voting rule (it returns a
 * `decided('scheduled', ...)` from `_runVotingRules`), not an entry fill like
 * autoFill/emergencyFill, and sharing the word "fill" with them read as if the
 * three were siblings.
 */
const SETTINGS_GROUPS = [
    { id: 'general', label: 'app.groupGeneral', tier: 'core' },
    { id: 'boost', label: 'app.groupBoost', tier: 'core' },
    { id: 'turbo', label: 'app.groupTurbo', tier: 'core' },
    { id: 'currencyAuto', label: 'app.groupCurrencyAuto', tier: 'core' },
    { id: 'autoFill', label: 'app.groupAutoFill', tier: 'entries' },
    { id: 'autoJoin', label: 'app.groupAutoJoin', tier: 'entries' },
    { id: 'finalWindow', label: 'app.groupFinalWindow', tier: 'overrides' },
    { id: 'lastMinute', label: 'app.groupLastMinute', tier: 'overrides' },
    { id: 'scheduledFill', label: 'app.groupScheduledFill', tier: 'overrides' },
    { id: 'votingPause', label: 'app.groupVotingPause', tier: 'overrides' },
    { id: 'rewards', label: 'app.groupRewards', tier: 'app' },
    { id: 'notifications', label: 'app.groupNotifications', tier: 'app' },
    { id: 'display', label: 'app.groupDisplay', tier: 'app' },
];

/**
 * Validate a single setting value against SETTINGS_SCHEMA. Keys that are
 * not in the schema are treated as valid because the schema is the only
 * source of validation rules for per-challenge tunables.
 *
 * @param {string} key
 * @param {*} value
 * @param {Record<string, any>|null} [allSettings]
 * @param {string|null} [challengeId]
 * @returns {boolean}
 */
const validateSetting = (key, value, allSettings = null, challengeId = null) => {
    const schemaConfig = SETTINGS_SCHEMA[key];
    if (!schemaConfig) return true;
    if (schemaConfig.validation && !schemaConfig.validation.safeParse(value).success) return false;
    if (schemaConfig.contextValidation && allSettings) {
        if (!schemaConfig.contextValidation(value, allSettings, challengeId)) return false;
    }
    return true;
};

/**
 * Get detailed validation error information for a setting. Returns null
 * when the value is valid. Mirrors `validateSetting`'s call signature
 * (challengeId is forwarded to contextValidation) so a future schema
 * entry that depends on per-challenge context behaves identically
 * across both validation paths.
 *
 * @param {string} settingKey
 * @param {*} value
 * @param {Record<string, any>|null} [allSettings]
 * @param {string|null} [challengeId]
 * @returns {string|null}
 */
const getValidationError = (settingKey, value, allSettings = null, challengeId = null) => {
    const schemaConfig = SETTINGS_SCHEMA[settingKey];
    if (!schemaConfig) {
        return null; // No schema config, assume valid
    }

    if (schemaConfig.validation) {
        const parsed = schemaConfig.validation.safeParse(value);
        if (!parsed.success) {
            // Prefer zod's own issue message when it carries real information
            // (custom refine messages, "expected number" type mismatches);
            // zod's generic refine fallback "Invalid input" adds nothing over
            // the historical constant, so keep 'Invalid value' there.
            const issueMessage = parsed.error?.issues?.[0]?.message;
            return issueMessage && issueMessage !== 'Invalid input' ? issueMessage : 'Invalid value';
        }
    }

    if (schemaConfig.contextValidation && allSettings) {
        if (!schemaConfig.contextValidation(value, allSettings, challengeId)) {
            if (schemaConfig.getContextError) {
                return schemaConfig.getContextError(value, allSettings, challengeId);
            }
            return 'Invalid value in current context';
        }
    }

    return null; // Valid
};

/**
 * Async getter exposed via IPC; returns the schema as-is. Async signature
 * preserved so existing renderer call sites don't need to change.
 */
const getSettingsSchema = async () => SETTINGS_SCHEMA;

module.exports = {
    SETTINGS_SCHEMA,
    SETTINGS_GROUPS,
    SETTINGS_TIERS,
    getSchemaDefault,
    validateSetting,
    getValidationError,
    getSettingsSchema,
    sanitizeFillSchedule,
    sanitizeTimeOfDayList,
    sanitizeBeforeEndList,
    // Shared cap for the scheduled-fill lists: the write path enforces it via
    // zod, the load-time bounds migration heals older data, and the hot-path
    // consumers (VotingLogic, scheduledFill.js, the settings modal) slice
    // defensively with it so a post-migration hand-edited array can't inflate
    // per-cycle Intl work.
    MAX_SCHEDULED_FILL_ENTRIES,
};
