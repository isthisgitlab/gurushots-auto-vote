import type { ChallengeValues } from '../../types/settings';
import type { RendererSchema } from '../../types/settingsEditor';

/**
 * Keep only the keys the schema allows as per-challenge overrides; without a
 * schema (its fetch failed) no key is known to be allowed.
 */
export const perChallengeOnly = (
    schema: RendererSchema | null | undefined,
    values: ChallengeValues | null | undefined,
): ChallengeValues => {
    const kept: ChallengeValues = {};
    for (const [key, value] of Object.entries(values || {})) {
        if (schema?.[key]?.perChallenge) kept[key] = value;
    }
    return kept;
};
