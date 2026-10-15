/**
 * The frozen 1.x default settings blob, the base a 1.x settings file is merged over. A copy as of the last 1.x
 * release.
 */

import { isDevelopment } from '../../runtime';
import { V1_SETTINGS_SCHEMA } from './schema';

import type { V1Blob, V1Values } from './types';

/**
 * A fresh default blob. The `mock` default follows the environment, as in 1.x: development builds default to mock.
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
