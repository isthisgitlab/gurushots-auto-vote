/** Settings of the `lastMinute` group. */

import { minute1to59, zBool } from './validators';
import type { SettingsSchemaEntry } from './entry';

export const lastMinuteSettings = {
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
} satisfies Record<string, SettingsSchemaEntry>;
