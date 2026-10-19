/**
 * The frozen format 1 default settings blob, the base a format 1 settings file is merged over. Frozen as the last build that
 * wrote settings format 1 had it.
 */

import { isDevelopment } from '../../runtime';
import { V1_SETTINGS_SCHEMA } from './schema';

import type { V1Blob, V1Values } from './types';

/**
 * A fresh default blob. The `mock` default follows the environment, as in format 1: development builds default to mock.
 */
const getV1Defaults = (): V1Blob => {
    const globalDefaults: V1Values = {};
    for (const [key, entry] of Object.entries(V1_SETTINGS_SCHEMA)) {
        globalDefaults[key] = structuredClone(entry.default);
    }
    return {
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
        mock: isDevelopment(),
        token: '',
        onboardingCompleted: false,
        windowBounds: {
            login: { x: undefined, y: undefined, width: 800, height: 960 },
            main: { x: undefined, y: undefined, width: 800, height: 960 },
        },
        challengeSettings: {
            globalDefaults,
            perChallenge: {},
            titleRules: [],
            titleProfileSuppressions: {},
            entryPins: {},
        },
        apiHeaders: {},
    };
};

export { getV1Defaults };
