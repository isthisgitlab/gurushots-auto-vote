import { useEffect, useState, useCallback } from 'react';

/**
 * Reads the per-challenge effective values + override flags that
 * ChallengeCard renders from. Bundles five related state slots that used
 * to live inline next to unrelated render logic, and exposes a
 * `toggleCompact()` action so the card no longer has to re-derive the
 * "no override → set override; has override → remove override" sequence
 * inline.
 *
 * Returns:
 *   hasCustomSettings   any perChallenge key has an override
 *   onlyBoost           effective onlyBoost value
 *   autoFillEnabled     effective autoFill value
 *   isCompact           effective compactCards value
 *   hasCompactOverride  whether compactCards has a per-challenge override
 *   toggleCompact()     flip the per-card density (or remove the override)
 */
export function useChallengeSettings(challengeId) {
    const [hasCustomSettings, setHasCustomSettings] = useState(false);
    const [onlyBoost, setOnlyBoost] = useState(false);
    const [autoFillEnabled, setAutoFillEnabled] = useState(false);
    const [isCompact, setIsCompact] = useState(false);
    const [hasCompactOverride, setHasCompactOverride] = useState(false);

    useEffect(() => {
        const id = challengeId.toString();
        const load = async () => {
            try {
                const schema = await window.api.getSettingsSchema();
                let foundOverride = false;
                for (const [key, config] of Object.entries(schema)) {
                    if (!config.perChallenge) continue;
                    const override = await window.api.getChallengeOverride(key, id);
                    if (override !== null) {
                        foundOverride = true;
                        break;
                    }
                }
                setHasCustomSettings(foundOverride);

                const [boostOnly, fillOn, compact, compactOverride] = await Promise.all([
                    window.api.getEffectiveSetting('onlyBoost', id),
                    window.api.getEffectiveSetting('autoFill', id),
                    window.api.getEffectiveSetting('compactCards', id),
                    window.api.getChallengeOverride('compactCards', id),
                ]);
                setOnlyBoost(boostOnly);
                setAutoFillEnabled(fillOn === true);
                setIsCompact(compact === true);
                setHasCompactOverride(compactOverride !== null);
            } catch {
                // Leave the previous values in place; the parent context
                // re-runs this effect when settings-changed fires.
            }
        };
        load();
    }, [challengeId]);

    // First click sets a per-challenge override (opposite of current);
    // a second click on a card that already has an override removes it
    // (returns to global default).
    const toggleCompact = useCallback(async () => {
        const id = challengeId.toString();
        try {
            if (hasCompactOverride) {
                await window.api.removeChallengeOverride('compactCards', id);
            } else {
                await window.api.setChallengeOverride('compactCards', id, !isCompact);
            }
            const [next, override] = await Promise.all([
                window.api.getEffectiveSetting('compactCards', id),
                window.api.getChallengeOverride('compactCards', id),
            ]);
            setIsCompact(next === true);
            setHasCompactOverride(override !== null);
        } catch {
            // Leave UI as-is.
        }
    }, [challengeId, isCompact, hasCompactOverride]);

    return {
        hasCustomSettings,
        onlyBoost,
        autoFillEnabled,
        isCompact,
        hasCompactOverride,
        toggleCompact,
    };
}
