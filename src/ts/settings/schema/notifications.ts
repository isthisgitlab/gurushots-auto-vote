/**
 * The `notifications` group: OS desktop/mobile "action coming up" warnings.
 * All GLOBAL (perChallenge: false) and default OFF — entirely opt-in. Each
 * toggle gates one deadline action type; notifyLeadTime is how far ahead the
 * warning fires. The decision + delivery live in
 * services/deadlineNotifications.ts + the per-host notify adapters. Only the
 * enabled types are ever evaluated, so an all-off config (the default) costs
 * nothing per cycle. Scenario notices (a scenario's `notify` action, and a
 * halted scenario) are asked for explicitly by the user's own plan, so
 * notifyOnScenario is on by default.
 */

import { z } from 'zod';
import { zBool } from './validators';
import type { SettingsSchemaEntry } from './entry';

// Notification lead time (minutes before an action fires that a warning is
// shown). 1–60; integer minutes are enough resolution for a "don't shut down
// yet" heads-up.
const notifyLeadMinutes = z.number().int().min(1).max(60);

export const notificationsSettings = {
    notifyOnScenario: {
        type: 'boolean',
        default: true,
        perChallenge: false,
        validation: zBool,
        validationOrder: 1,
        group: 'notifications',
        label: 'app.notifyOnScenario',
        description: 'app.notifyOnScenarioDesc',
    },
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
} satisfies Record<string, SettingsSchemaEntry>;
