/**
 * The `general` group (exposure triggers and vote toggles) and the two
 * `display` card toggles declared beside it: key order here is the order the
 * settings modals and the CLI listing show, so they keep their place.
 */

import { z } from 'zod';
import { percentage, percentageOrZero, validatedNumber, zBool } from './validators';
import type { SettingsSchemaEntry } from './entry';

/**
 * The exposure value the exposure-dependent validators compare against:
 * the live `exposure` from allSettings when it is a valid 1–100 number,
 * otherwise the schema default. Shared by the exposureTarget and
 * finalWindowExposure context validators/error builders.
 */
export const effectiveExposureOf = (allSettings: Record<string, unknown>): number => {
    const exposureValue = allSettings.exposure;
    return typeof exposureValue === 'number' && exposureValue >= 1 && exposureValue <= 100
        ? exposureValue
        : Number(generalSettings.exposure.default);
};

export const generalSettings = {
    // NOTE on min/max/unit: the IPC schema projection and SettingInput forward these three
    // fields; without them a number input renders unbounded and unlabelled, and the only
    // feedback for an out-of-range value is a generic "could not be saved" banner. They
    // mirror the zod validator directly; keep the two in step when either changes.
    // The user-defined scenario (settings/scenarios.ts) this challenge runs,
    // by name; '' = none. challengeOnly: a scenario is assigned per challenge,
    // through a challenge rule or a profile — there is no "run it everywhere"
    // global value. An unknown name runs nothing (the engine logs it).
    scenario: {
        type: 'scenario',
        default: '',
        perChallenge: true,
        challengeOnly: true,
        validation: z.string().max(60),
        validationOrder: 1,
        group: 'general',
        label: 'app.scenario',
        description: 'app.scenarioDesc',
    },
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
        // 0 is a sentinel meaning "vote up to the exposure trigger value".
        // Any 1-100 explicitly overrides the target so the loop keeps voting past the trigger.
        default: 0,
        perChallenge: true,
        validation: percentageOrZero,
        min: 0,
        max: 100,
        unit: 'app.unitPercent',
        contextValidation: (value, allSettings) => {
            if (value === 0) return true; // sentinel — always ok
            return validatedNumber(value) >= effectiveExposureOf(allSettings);
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
        // among the exposure knobs.
        group: 'display',
        label: 'app.compactCards',
        description: 'app.compactCardsDesc',
    },
    // Global only: adds the challenge-level action buttons to every compact
    // tile. Display-only, like compactCards.
    compactCardActions: {
        type: 'boolean',
        default: false,
        perChallenge: false,
        validation: zBool,
        validationOrder: 1,
        group: 'display',
        label: 'app.compactCardActions',
        description: 'app.compactCardActionsDesc',
    },
} satisfies Record<string, SettingsSchemaEntry>;
