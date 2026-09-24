/**
 * Named challenge-settings profiles ("save this tactic, recall it later"):
 * list, save/overwrite, delete, apply to a challenge, and first-run seeding of
 * the curated intent presets. Name handling and value sanitization live in
 * profileStore.js; this module owns the load-modify-save around them.
 */

const logger = require('../logger');
const { INTENT_PROFILES } = require('./intentProfiles');
const { loadSettings, saveSettings } = require('./persistence');
const { ensureChallengeSettings, globalChallengeValues } = require('./defaults');
const {
    MAX_CHALLENGE_PROFILES,
    MAX_PROFILE_NAME_LENGTH,
    RESERVED_PROFILE_NAMES,
    normalizeProfileName,
    profileNameForLog,
    readProfilesMap,
    findProfileKey,
    sanitizeProfileValues,
} = require('./profileStore');
const { sanitizeTitleRuleInline } = require('./titleRuleSanitize');
const { titleProfileComposesWithKnownOverrides } = require('./ruleResolution');
const { replaceChallengeOverridesInSettings, trimmedChallengeId } = require('./challengeOverrides');

const _isReservedName = (name) => RESERVED_PROFILE_NAMES.has(normalizeProfileName(name));

/**
 * Get the saved profiles as `{ [displayName]: { [settingKey]: value } }`.
 * Defensive copy; values are sanitized drop-silently (stale schema keys and
 * now-invalid values disappear from the view without rewriting storage — the
 * next save of that profile persists the sanitized form).
 */
const getChallengeProfiles = () => {
    const settings = loadSettings();
    const stored = readProfilesMap(settings);
    const globalDefaults = globalChallengeValues(settings);
    const profiles = {};
    for (const name of Object.keys(stored)) {
        if (_isReservedName(name)) continue;
        profiles[name] = sanitizeProfileValues(stored[name], false, globalDefaults);
    }
    return profiles;
};

const _updateAssignedProfileRules = (settings, normalizedName, displayName, values) => {
    const rules = Array.isArray(settings.challengeSettings.titleRules) ? settings.challengeSettings.titleRules : [];
    const assigned = rules.filter((rule) => normalizeProfileName(rule?.profile) === normalizedName);
    if (assigned.some((rule) => !titleProfileComposesWithKnownOverrides(settings, rule, values))) {
        logger
            .withCategory('settings')
            .error(
                `Profile overwrite conflicts with manual challenge overrides: "${profileNameForLog(displayName)}"`,
                null,
            );
        return false;
    }
    if (assigned.length) {
        settings.challengeSettings.titleRules = rules.map((rule) =>
            normalizeProfileName(rule?.profile) === normalizedName ? { ...rule, profile: displayName } : rule,
        );
    }
    return true;
};

/**
 * Own-property copy of the stored profiles minus reserved names and minus the
 * profile being saved (so a same-normalized-name save replaces the old casing
 * in place). `existed` reports whether that profile was present.
 */
const _profilesWithout = (stored, normalized) => {
    const profiles = {};
    let existed = false;
    for (const existingName of Object.keys(stored)) {
        const key = normalizeProfileName(existingName);
        if (RESERVED_PROFILE_NAMES.has(key)) continue;
        if (key === normalized) {
            existed = true;
            continue;
        }
        profiles[existingName] = stored[existingName];
    }
    return { profiles, existed };
};

/**
 * Save (or overwrite) a named profile. Fail-closed: rejects a bad/reserved
 * name, the profile-count cap (new names only — overwriting an existing name
 * always succeeds), a non-plain-object values payload, or any invalid value.
 * An empty values map is allowed — it's a useful "all global defaults" preset.
 */
const saveChallengeProfile = (name, values) => {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    const normalized = normalizeProfileName(trimmed);
    if (!trimmed || trimmed.length > MAX_PROFILE_NAME_LENGTH || RESERVED_PROFILE_NAMES.has(normalized)) {
        logger.withCategory('settings').error(`Invalid profile name: "${profileNameForLog(name)}"`, null);
        return false;
    }

    const settings = loadSettings();
    const globalDefaults = globalChallengeValues(settings);
    const sanitized = sanitizeProfileValues(values, true, globalDefaults);
    if (sanitized === null) {
        return false;
    }

    const challengeSettings = ensureChallengeSettings(settings);
    // Rebuilt via own-property copy: drops prototype-named keys a corrupted
    // blob might carry.
    const { profiles, existed } = _profilesWithout(readProfilesMap(settings), normalized);
    if (!existed && Object.keys(profiles).length >= MAX_CHALLENGE_PROFILES) {
        logger
            .withCategory('settings')
            .error(`saveChallengeProfile rejected: profile cap of ${MAX_CHALLENGE_PROFILES} reached`, null);
        return false;
    }

    if (existed && !_updateAssignedProfileRules(settings, normalized, trimmed, sanitized)) return false;
    profiles[trimmed] = sanitized;
    challengeSettings.profiles = profiles;
    return saveSettings(settings);
};

/**
 * A rule with its profile assignment removed, or null when the profile was the
 * rule's sole contribution (no tags, no valid inline overrides left).
 */
const _ruleWithoutProfile = (rule) => {
    const withoutProfile = { ...rule };
    delete withoutProfile.profile;
    const hasTags =
        (Array.isArray(withoutProfile.mustIncludeTags) && withoutProfile.mustIncludeTags.length > 0) ||
        (Array.isArray(withoutProfile.shouldIncludeTags) && withoutProfile.shouldIncludeTags.length > 0);
    const inline = sanitizeTitleRuleInline(withoutProfile);
    const hasInline = inline !== null && Object.keys(inline).length > 0;
    return hasTags || hasInline ? withoutProfile : null;
};

/**
 * Delete a profile by name (case-insensitive on the normalized name).
 * Returns false when no such profile exists.
 */
const deleteChallengeProfile = (name) => {
    const normalized = normalizeProfileName(name);
    if (!normalized || RESERVED_PROFILE_NAMES.has(normalized)) {
        return false;
    }
    const settings = loadSettings();
    const stored = readProfilesMap(settings);
    const storedKey = findProfileKey(stored, normalized);
    if (storedKey === null) {
        return false;
    }
    delete stored[storedKey];
    settings.challengeSettings.profiles = stored;

    // A deleted profile cannot remain as an invisible stale assignment. Keep
    // any tags or inline overrides on the same rule; drop the row only when the
    // profile was its sole contribution.
    const rules = settings.challengeSettings.titleRules;
    if (Array.isArray(rules)) {
        settings.challengeSettings.titleRules = rules.flatMap((rule) => {
            if (normalizeProfileName(rule?.profile) !== normalized) return [rule];
            const kept = _ruleWithoutProfile(rule);
            return kept ? [kept] : [];
        });
    }
    return saveSettings(settings);
};

/**
 * Apply a profile to a challenge: atomically REPLACE the challenge's whole
 * override container with the profile's sanitized values in one
 * load-modify-save.
 *
 * Deliberately NOT setChallengeOverrides + removeChallengeOverride sweeps:
 * that path validates each profile key against a context still containing the
 * challenge's stale, about-to-be-removed overrides (so e.g. a stale
 * exposure=95 override rejects a profile's exposureTarget=80), silently
 * swallows 'invalid' results, and leaves a multi-write window a running vote
 * loop could observe half-applied. Here every value is validated against
 * {globalDefaults + profile} — the same context the profile was saved under —
 * and nothing is written unless all of it passes.
 */
const applyChallengeProfile = (name, challengeId) => {
    const id = trimmedChallengeId(challengeId);
    if (!id) {
        logger.withCategory('settings').error('applyChallengeProfile requires a challenge id', null);
        return false;
    }

    const normalized = normalizeProfileName(name);
    if (!normalized || RESERVED_PROFILE_NAMES.has(normalized)) {
        logger.withCategory('settings').error(`Invalid profile name: "${profileNameForLog(name)}"`, null);
        return false;
    }

    const settings = loadSettings();
    const stored = readProfilesMap(settings);
    const storedKey = findProfileKey(stored, normalized);
    if (storedKey === null) {
        logger.withCategory('settings').error(`Profile not found: "${profileNameForLog(name)}"`, null);
        return false;
    }

    const globalDefaults = globalChallengeValues(settings);
    // Fail-closed: sanitizeProfileValues logs the failing key, so a
    // schema-drifted profile's failure is diagnosable from the log.
    const sanitized = sanitizeProfileValues(stored[storedKey], true, globalDefaults);
    if (sanitized === null) {
        return false;
    }

    // Safety net: sanitizeProfileValues already validated these values against
    // the same {globals + profile} context, so this only fails if a schema rule
    // starts depending on the challenge id. Kept so nothing invalid is persisted.
    /* istanbul ignore if */
    if (!replaceChallengeOverridesInSettings(settings, id, sanitized, true)) return false;
    return saveSettings(settings);
};

/**
 * Seed the curated "intent" presets (settings/intentProfiles.js) into the
 * named-profiles store on first run. Idempotent and collision-safe:
 *
 *  - A per-profile marker in `challengeSettings.seededProfiles` (normalized
 *    names) records which intents were already seeded, so deleting one does
 *    NOT resurrect it on the next run.
 *  - An intent is written only when no profile with that normalized name
 *    already exists — a user's own same-named profile is never clobbered.
 *  - Seeding goes through saveChallengeProfile so the reserved-name guard,
 *    perChallenge whitelist, and zod + contextValidation-as-a-set all run in
 *    the vetted path. Bundles are self-contained, so a save failure that is NOT
 *    the profile cap is structural (schema drift): it is logged and the intent
 *    is marked seeded to avoid retrying every load. The profile cap, by
 *    contrast, is TRANSIENT — a user already at MAX_CHALLENGE_PROFILES is
 *    pre-checked and left UN-marked so the built-in seeds on a later run once
 *    they free capacity, rather than being permanently and silently suppressed.
 *
 * Returns true when nothing needed seeding or the seed-marker write succeeded.
 */
const seedIntentProfiles = () => {
    const settings = loadSettings();
    const priorSeeded = Array.isArray(settings.challengeSettings?.seededProfiles)
        ? settings.challengeSettings.seededProfiles
        : [];
    const seededSet = new Set(priorSeeded.map(normalizeProfileName));
    const stored = readProfilesMap(settings);
    // Live count of real (non-reserved) profiles, kept in step with successful
    // saves so the cap pre-check stays accurate across the loop.
    let profileCount = Object.keys(stored).filter((name) => !_isReservedName(name)).length;

    let changed = false;
    for (const intent of INTENT_PROFILES) {
        const normalized = normalizeProfileName(intent.name);
        if (seededSet.has(normalized)) continue; // already seeded once — respect a later deletion

        // A user's own same-named profile — never clobber it; mark seeded so it
        // isn't retried.
        if (findProfileKey(stored, normalized) !== null) {
            seededSet.add(normalized);
            changed = true;
            continue;
        }

        // Transient cap: do NOT mark seeded, so it retries once capacity frees.
        if (profileCount >= MAX_CHALLENGE_PROFILES) {
            logger
                .withCategory('settings')
                .info(
                    `Deferred seeding intent profile "${profileNameForLog(intent.name)}" — profile cap (${MAX_CHALLENGE_PROFILES}) reached; will retry`,
                );
            continue;
        }

        const ok = saveChallengeProfile(intent.name, intent.values);
        if (ok) {
            profileCount += 1;
        } else {
            // Not the cap (pre-checked): a structural failure that won't
            // self-heal, so mark it seeded to avoid retrying every load.
            logger
                .withCategory('settings')
                .warning(
                    `Skipped seeding intent profile "${profileNameForLog(intent.name)}" (invalid for this install)`,
                );
        }
        seededSet.add(normalized);
        changed = true;
    }

    if (!changed) return true;

    // saveChallengeProfile persisted the new profiles via its own load/save,
    // so re-load fresh before recording the seed markers to avoid clobbering
    // them with this now-stale snapshot.
    const fresh = loadSettings();
    ensureChallengeSettings(fresh).seededProfiles = Array.from(seededSet);
    return saveSettings(fresh);
};

module.exports = {
    getChallengeProfiles,
    saveChallengeProfile,
    deleteChallengeProfile,
    applyChallengeProfile,
    seedIntentProfiles,
    MAX_CHALLENGE_PROFILES,
    MAX_PROFILE_NAME_LENGTH,
};
