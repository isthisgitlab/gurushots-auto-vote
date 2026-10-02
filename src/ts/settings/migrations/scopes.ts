import { RESERVED_PROFILE_NAMES, normalizeProfileName } from '../profileStore';

import type { AppSettings, ChallengeValues } from '../../types/settings';

// The three scope families every scheduled-fill migration must walk:
// globalDefaults, every perChallenge override map, and every profile's values
// map. Profiles matter because sanitizeProfileValues(failClosed=false)
// silently drops schema-invalid values on the read path — an unmigrated
// scalar inside a profile would vanish from the profile view and be lost on
// the next save. Prototype-shaped profile names are skipped, mirroring
// getChallengeProfiles' own-property iteration.
export const _eachScheduledFillScope = (
    mergedSettings: AppSettings,
    visit: (scope: ChallengeValues | undefined, label: string, isGlobalScope: boolean) => void,
) => {
    visit(mergedSettings.challengeSettings?.globalDefaults, 'global default', true);
    const perChallenge = mergedSettings.challengeSettings?.perChallenge || {};
    for (const [challengeId, overrides] of Object.entries(perChallenge)) {
        visit(overrides, `override on challenge ${challengeId}`, false);
    }
    const profiles = mergedSettings.challengeSettings?.profiles;
    if (profiles && typeof profiles === 'object' && !Array.isArray(profiles)) {
        for (const name of Object.keys(profiles)) {
            if (RESERVED_PROFILE_NAMES.has(normalizeProfileName(name))) continue;
            const values = profiles[name];
            if (values && typeof values === 'object' && !Array.isArray(values)) {
                visit(values, `profile "${name}"`, false);
            }
        }
    }
};
