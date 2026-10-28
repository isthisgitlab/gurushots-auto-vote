/**
 * Shared profile-name checks for the two "save current as profile" surfaces:
 * the challenge modal's ChallengeProfilesBar and the Profiles tab's Save-as
 * row. Mirrors the facade's save-side rules (settings/profiles.ts) so a name
 * the client accepts is one the backend saves, and at the profile cap an
 * overwrite of an existing name still passes (new names only are counted
 * against the cap).
 */

import { RESERVED_PROFILE_NAMES, normalizeProfileName } from '../../settings/limits';

import type { Translate } from '../../translations/translator';

export { normalizeProfileName };

// How long an armed confirm button (delete / overwrite / rename) stays armed
// before falling back to its idle state.
const CONFIRM_TIMEOUT_MS = 4000;

/** The caps the get-settings-schema response ships (`profileLimits`). */
type ProfileNameLimits = { maxChallengeProfiles?: number; maxProfileNameLength?: number } | null | undefined;

/**
 * What checkProfileName made of a trimmed candidate name. `tooLong` and
 * `limit` carry the bound the message names, `existing` the stored name as it
 * is written (matched case-insensitively).
 */
export type ProfileNameCheck =
    | 'required'
    | { tooLong: number }
    | 'reserved'
    | { existing: string }
    | { limit: number }
    | 'ok';

/**
 * Check a trimmed candidate name against the stored profile names, in the
 * save path's order: required → too long → reserved → existing → limit → ok.
 * The caps are only applied when `limits` carries them; without it the
 * client-side checks are skipped and the facade's fail-closed save guards.
 */
export const checkProfileName = (trimmed: string, names: string[], limits?: ProfileNameLimits): ProfileNameCheck => {
    if (!trimmed) return 'required';
    const maxNameLength = limits?.maxProfileNameLength;
    if (maxNameLength != null && trimmed.length > maxNameLength) return { tooLong: maxNameLength };
    const normalized = normalizeProfileName(trimmed);
    if (RESERVED_PROFILE_NAMES.has(normalized)) return 'reserved';
    for (const name of names) {
        if (normalizeProfileName(name) === normalized) return { existing: name };
    }
    const maxProfiles = limits?.maxChallengeProfiles;
    if (maxProfiles != null && names.length >= maxProfiles) return { limit: maxProfiles };
    return 'ok';
};

/**
 * The translated message for a checkProfileName error result, or null for
 * `existing` and `ok` (those are decisions the caller acts on, not errors).
 * tooLong and limit fill the bound into the existing `{0}` strings.
 */
const profileNameCheckMessage = (check: ProfileNameCheck, t: Translate): string | null => {
    if (check === 'required') return t('app.profileNameRequired');
    if (typeof check === 'object' && 'tooLong' in check) return t('app.profileNameTooLong', { '0': check.tooLong });
    if (check === 'reserved') return t('app.profileNameReserved');
    if (typeof check === 'object' && 'limit' in check) return t('app.profileLimitReached', { '0': check.limit });
    return null;
};

export { CONFIRM_TIMEOUT_MS, profileNameCheckMessage };
