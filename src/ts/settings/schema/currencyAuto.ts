/**
 * The `currencyAuto` group, labelled "Keys, Swaps & Fills" in the UI: automatic
 * spending of the three bankroll currencies the manual card buttons spend
 * (services/currencyActions.ts). Global defaults apply to every challenge
 * unless a profile or per-challenge setting overrides them. Each action has
 * three optional timing conditions (after start, before end, after % elapsed);
 * every condition that is set must hold (0 = that condition off, family-1
 * sentinel), and none set means "any time". The pure rule math lives in
 * voting/currencyAuto.ts.
 */

import { z } from 'zod';
import { MAX_SCHEDULE_SECONDS, elapsedPercentSetting, entrySlotSetting, percentage, zBool } from './validators';
import type { SettingsSchemaEntry } from './entry';

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
// Seconds-after-start / seconds-before-end condition of a currency rule. 0 = that
// condition is off. Capped like every other duration.
const currencyRuleSec = z.number().int().min(0).max(MAX_SCHEDULE_SECONDS);
const spendCountSetting = (unit: string) =>
    ({
        type: 'number',
        default: 1,
        perChallenge: true,
        validation: autoSpendCount,
        min: 1,
        max: MAX_AUTO_SPENDS_PER_CHALLENGE,
        unit,
        validationOrder: 1,
    }) satisfies Partial<SettingsSchemaEntry>;
// Global reserve (not per challenge): automation never spends the balance
// below this. Manual spends from the card are not limited by it.
const currencyReserveSetting = (unit: string) =>
    ({
        type: 'number',
        default: 0,
        perChallenge: false,
        validation: currencyReserve,
        min: 0,
        max: MAX_CURRENCY_RESERVE,
        unit,
        validationOrder: 1,
    }) satisfies Partial<SettingsSchemaEntry>;

export const currencyAutoSettings = {
    autoKeyUnlock: {
        type: 'boolean',
        default: false,
        perChallenge: true,
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
        validation: currencyRuleSec,
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoKeyBeforeEnd',
        description: 'app.autoKeyBeforeEndDesc',
        helpKey: 'app.currencyRuleTimingHelp',
    },
    autoKeyAfterPercent: {
        ...elapsedPercentSetting,
        group: 'currencyAuto',
        label: 'app.autoKeyAfterPercent',
        description: 'app.autoKeyAfterPercentDesc',
        helpKey: 'app.currencyRuleTimingHelp',
    },
    autoSwap: {
        type: 'boolean',
        default: false,
        perChallenge: true,
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
        validation: currencyRuleSec,
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoSwapBeforeEnd',
        description: 'app.autoSwapBeforeEndDesc',
        helpKey: 'app.currencyRuleTimingHelp',
    },
    autoSwapAfterPercent: {
        ...elapsedPercentSetting,
        group: 'currencyAuto',
        label: 'app.autoSwapAfterPercent',
        description: 'app.autoSwapAfterPercentDesc',
        helpKey: 'app.currencyRuleTimingHelp',
    },
    // Which entry a swap replaces: 1-4 = that slot, 0 = the last entry — the same
    // convention as boostImageIndex / turboImageIndex.
    autoSwapImageIndex: {
        ...entrySlotSetting(0),
        group: 'currencyAuto',
        label: 'app.autoSwapImageIndex',
        description: 'app.autoSwapImageIndexDesc',
    },
    autoSwapLowestVotes: {
        type: 'boolean',
        default: false,
        perChallenge: true,
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
        ...spendCountSetting('app.unitSwaps'),
        group: 'currencyAuto',
        label: 'app.autoSwapMax',
        description: 'app.autoSwapMaxDesc',
    },
    autoExposureFill: {
        type: 'boolean',
        default: false,
        perChallenge: true,
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
        validation: currencyRuleSec,
        validationOrder: 1,
        group: 'currencyAuto',
        label: 'app.autoExposureFillBeforeEnd',
        description: 'app.autoExposureFillBeforeEndDesc',
        helpKey: 'app.currencyRuleTimingHelp',
    },
    autoExposureFillAfterPercent: {
        ...elapsedPercentSetting,
        group: 'currencyAuto',
        label: 'app.autoExposureFillAfterPercent',
        description: 'app.autoExposureFillAfterPercentDesc',
        helpKey: 'app.currencyRuleTimingHelp',
    },
    autoExposureFillMax: {
        ...spendCountSetting('app.unitFills'),
        group: 'currencyAuto',
        label: 'app.autoExposureFillMax',
        description: 'app.autoExposureFillMaxDesc',
    },
    currencyReserveKeys: {
        ...currencyReserveSetting('app.unitKeys'),
        group: 'currencyAuto',
        label: 'app.currencyReserveKeys',
        description: 'app.currencyReserveKeysDesc',
    },
    currencyReserveSwaps: {
        ...currencyReserveSetting('app.unitSwaps'),
        group: 'currencyAuto',
        label: 'app.currencyReserveSwaps',
        description: 'app.currencyReserveSwapsDesc',
    },
    currencyReserveFills: {
        ...currencyReserveSetting('app.unitFills'),
        group: 'currencyAuto',
        label: 'app.currencyReserveFills',
        description: 'app.currencyReserveFillsDesc',
    },
} satisfies Record<string, SettingsSchemaEntry>;
