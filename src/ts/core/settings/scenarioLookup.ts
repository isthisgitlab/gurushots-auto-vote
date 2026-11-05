/**
 * Read-side lookup of a stored scenario in an already loaded configuration. A module of its own, with no dependency on
 * the stored configuration, so the import report can ask the same question the engine does.
 */

import { globalChallengeValues } from './defaults';
import { normalizeProfileName, findProfileKey } from './profileStore';
import { validateScenario } from './scenarioSchema';

import type { ConfigV2 } from '../types/config';
import type { ChallengeValues } from '../types/settings';
import type { ScenarioDocument } from './scenarioSchema';

// Read-side validation runs on every lookup (the engine resolves a scenario
// per challenge per pass), so results are memoized by the stored document and
// the global defaults its phase settings are checked against.
const VALIDATION_CACHE_LIMIT = 200;
const validationCache: Map<string, ReturnType<typeof validateScenario>> = new Map();

const validateStored = (raw: unknown, globalDefaults: ChallengeValues): ReturnType<typeof validateScenario> => {
    const key = JSON.stringify([raw, globalDefaults]);
    if (!validationCache.has(key)) {
        if (validationCache.size >= VALIDATION_CACHE_LIMIT) validationCache.clear();
        validationCache.set(key, validateScenario(raw, globalDefaults));
    }
    return validationCache.get(key) as ReturnType<typeof validateScenario>;
};

/**
 * The valid stored scenario named `name` (case-insensitive) in an already
 * loaded settings object, or null. Not a copy — callers only read it. Used by
 * the phase-settings overlay, which must not load settings a second time.
 */
const findStoredScenario = (settings: ConfigV2, name: unknown): ScenarioDocument | null => {
    const stored = settings.scenarios;
    const key = findProfileKey(stored, normalizeProfileName(name));
    if (key === null) return null;
    const result = validateStored(stored[key], globalChallengeValues(settings));
    return result.ok ? result.scenario : null;
};

export { findStoredScenario, validateStored };
