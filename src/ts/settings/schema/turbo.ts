/** Settings of the `turbo` group. */

import { entrySlotSetting, nonNegNumber, zBool } from './validators';
import type { SettingsSchemaEntry } from './entry';

export const turboSettings = {
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
        ...entrySlotSetting(1),
        group: 'turbo',
        label: 'app.turboImageIndex',
        description: 'app.turboImageIndexDesc',
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
} satisfies Record<string, SettingsSchemaEntry>;
