/**
 * The @capacitor/preferences plugin, lazy-required so non-Capacitor bundles never resolve it, and the removal of the
 * keys the stores persisted under.
 */

import type { PreferencesPlugin } from '@capacitor/preferences';

let capacitorPreferences: PreferencesPlugin | null = null;

const getCapacitorPreferences = (): PreferencesPlugin => {
    if (capacitorPreferences) return capacitorPreferences;
    const plugin: PreferencesPlugin = (require('@capacitor/preferences') as typeof import('@capacitor/preferences'))
        .Preferences;
    capacitorPreferences = plugin;
    return plugin;
};

/**
 * Removes Preferences keys (Capacitor): the stores' persisted values.
 */
const removePreferenceKeys = async (keys: readonly string[]): Promise<void> => {
    const preferences = getCapacitorPreferences();
    for (const key of keys) await preferences.remove({ key });
};

export { getCapacitorPreferences, removePreferenceKeys };
