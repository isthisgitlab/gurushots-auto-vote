/**
 * The `rewards` and `missions` groups: global automation, default off, that
 * claims prizes and follows the active missions.
 */

import { zBool } from './validators';
import type { SettingsSchemaEntry } from './entry';

export const rewardsSettings = {
    // Claim finished-challenge rewards and completed-mission prizes
    // automatically. GLOBAL and default OFF; the pass runs as a pre-step of the
    // voting cycle but at most once an hour (services/autoClaim.ts).
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
    // Mission-aware automation (services/missions.ts). GLOBAL and default OFF;
    // each reads the active missions once per voting cycle.
    // Save turbos: an earnable turbo waits unearned until a "Win Turbo" mission
    // wants it or its apply window (turboTime) is an hour away.
    missionSaveTurbos: {
        type: 'boolean',
        default: false,
        perChallenge: false,
        validation: zBool,
        validationOrder: 1,
        group: 'missions',
        label: 'app.missionSaveTurbos',
        description: 'app.missionSaveTurbosDesc',
    },
    // Join early: during a "Join N challenges" or "Win Turbo" mission the
    // auto-join timing window is lifted until the mission is met — a turbo is
    // only winnable in a joined challenge (the type/tag/coin filters stay).
    missionJoinEarly: {
        type: 'boolean',
        default: false,
        perChallenge: false,
        validation: zBool,
        validationOrder: 1,
        group: 'missions',
        label: 'app.missionJoinEarly',
        description: 'app.missionJoinEarlyDesc',
    },
    // Use fills: during a "Use Fill N times" mission, spend fills (above the
    // fill reserve) on challenges below 100% exposure until the mission is met.
    missionUseFills: {
        type: 'boolean',
        default: false,
        perChallenge: false,
        validation: zBool,
        validationOrder: 1,
        group: 'missions',
        label: 'app.missionUseFills',
        description: 'app.missionUseFillsDesc',
    },
    // Vote for missions: during a "Vote on N photos" mission, vote every cycle
    // without waiting for the exposure threshold (see services/missions.ts).
    missionVote: {
        type: 'boolean',
        default: false,
        perChallenge: false,
        validation: zBool,
        validationOrder: 1,
        group: 'missions',
        label: 'app.missionVote',
        description: 'app.missionVoteDesc',
    },
} satisfies Record<string, SettingsSchemaEntry>;
