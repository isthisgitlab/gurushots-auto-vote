/**
 * The `autoJoin` group. The scope model is "default = all types" narrowed by
 * autoJoinTypes: enabling autoJoin joins ALL open (free) challenges unless a
 * type list narrows it. Paid stays gated by the coin caps (0 = free only), so
 * no unintended spend. An orphaned autoJoinAll key in a stored settings file
 * is inert (never read; pruned by cleanupObsoleteSettings).
 */

import { z } from 'zod';
import { elapsedPercentSetting, zBool, zString } from './validators';
import type { SettingsSchemaEntry } from './entry';

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

export const autoJoinSettings = {
    // Enable for the automatic join pre-step (runs each voting cycle on every
    // platform). Default off, but resolved master → profile → per-challenge, so a
    // title profile can turn it on for its title. Scope below decides WHICH open
    // challenges are joined; the coin caps gate paid ones.
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
    // of its close_time. 0 = off (join as soon as the candidate is seen), so
    // this is the "0 = feature off" sentinel family, NOT the exposureTarget
    // "0 = same as trigger" one.
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
    // wins (see resolveJoinWindow in services/decisions/joinDecision.ts) — one candidate
    // gets ONE window, never the intersection of two, so the effective timing is
    // always readable off a single number.
    //
    // FAIL-CLOSED exactly like the hours window, and on one more field: percent
    // mode needs start_time AND close_time to know the challenge's length, so a
    // candidate missing either is deferred rather than joined.
    autoJoinAfterPercentElapsed: {
        ...elapsedPercentSetting,
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
} satisfies Record<string, SettingsSchemaEntry>;
