/**
 * Curated "intent" presets, seeded into the named-profiles system on first
 * run (see settings.js `seedIntentProfiles`). Deliberately free of any
 * dependency — NO zod — so it is safe to import into the renderer bundle
 * (mirrors settings/limits.js).
 *
 * Each bundle is SELF-CONTAINED: it sets both sides of every cross-field pair
 * it touches (exposure/exposureTarget, lastHourExposure/lastHourExposureTarget)
 * so `_sanitizeProfileValues` validates it as a set regardless of the user's
 * customized global defaults. Values equal to a default are harmless — apply
 * prunes them when writing the per-challenge override container.
 *
 * `name` is the stored profile key (identity — profiles are name-keyed like
 * every profile, so an id rotation never loses it). `nameKey`/`descKey` are
 * i18n keys used only for localized display in the picker; the stored name
 * stays stable across languages so the built-in match keeps working.
 */

// Sentinel-family note: exposureTarget / lastHourExposureTarget are family 2
// (0 = "follow the trigger", rule still active); every *Time / *Fill value is
// family 1 (0 = off). These bundles never conflate the two.
const INTENT_PROFILES = [
    {
        id: 'justParticipate',
        name: 'Just Participate',
        nameKey: 'app.intentJustParticipate',
        descKey: 'app.intentJustParticipateDesc',
        // Keep entries filled, but never spend a Boost or Turbo and don't chase
        // exposure past the trigger.
        values: {
            exposure: 100,
            exposureTarget: 0,
            autoBoost: false,
            useTurbo: false,
            autoTurbo: false,
            autoFill: true,
        },
    },
    {
        id: 'finishStrong',
        name: 'Finish Strong',
        nameKey: 'app.intentFinishStrong',
        descKey: 'app.intentFinishStrongDesc',
        // Spend Boost + Turbo and push exposure hard in the final hour, but
        // play the rest of the challenge normally (exposureTarget follows the
        // trigger).
        values: {
            exposure: 100,
            exposureTarget: 0,
            autoBoost: true,
            useTurbo: true,
            autoTurbo: true,
            useLastHourExposure: true,
            lastHourExposure: 100,
            lastHourExposureTarget: 100,
        },
    },
    {
        id: 'maxExposure',
        name: 'Max Exposure',
        nameKey: 'app.intentMaxExposure',
        descKey: 'app.intentMaxExposureDesc',
        // Push everything the whole way: vote to full exposure throughout, fill
        // entries, and spend Boost + Turbo.
        values: {
            exposure: 100,
            exposureTarget: 100,
            autoBoost: true,
            useTurbo: true,
            autoTurbo: true,
            autoFill: true,
            useLastHourExposure: true,
            lastHourExposure: 100,
            lastHourExposureTarget: 100,
        },
    },
];

const _norm = (name) => (typeof name === 'string' ? name.trim().toLowerCase() : '');

/** The intent whose stored name matches `name` (trim+lowercase), or null. */
const getIntentByName = (name) => {
    const n = _norm(name);
    if (!n) return null;
    return INTENT_PROFILES.find((intent) => _norm(intent.name) === n) || null;
};

/**
 * True when a stored profile's values still equal the canonical intent bundle,
 * i.e. the user hasn't edited it. Compares the union of keys so an added or
 * removed key counts as "modified".
 */
const intentValuesMatch = (intent, storedValues) => {
    if (!intent || !storedValues || typeof storedValues !== 'object') return false;
    const keys = new Set([...Object.keys(intent.values), ...Object.keys(storedValues)]);
    for (const key of keys) {
        if (intent.values[key] !== storedValues[key]) return false;
    }
    return true;
};

module.exports = { INTENT_PROFILES, getIntentByName, intentValuesMatch };
