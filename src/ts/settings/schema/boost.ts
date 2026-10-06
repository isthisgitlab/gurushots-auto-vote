/** Settings of the `boost` group. */

import { entrySlotSetting, minute1to59, nonNegNumber, zBool } from './validators';
import type { SettingsSchemaEntry } from './entry';

export const boostSettings = {
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
    // A boost spent on a photo the moment it enters the challenge gets few votes, so the
    // boost waits until its target has been in the challenge this long. Measured from when
    // the app first saw the photo (its own submit, or the first poll after a manual one).
    boostFreshEntryWait: {
        type: 'time', // hours/minutes input, stored as seconds
        default: 180, // 3 minutes in seconds
        perChallenge: true,
        validation: nonNegNumber,
        validationOrder: 1,
        group: 'boost',
        label: 'app.boostFreshEntryWait',
        description: 'app.boostFreshEntryWaitDesc',
    },
    // Desktop app only: when the computer goes to sleep while auto-vote runs, a boost due
    // within 30 min is sent right away (windows/suspendBoost.ts). Off keeps the boost at its
    // set time.
    boostOnSleep: {
        type: 'boolean',
        default: true,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'boost',
        label: 'app.boostOnSleep',
        description: 'app.boostOnSleepDesc',
    },
    boostImageIndex: {
        ...entrySlotSetting(1),
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
} satisfies Record<string, SettingsSchemaEntry>;
