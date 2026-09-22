import { useEffect, useState, useCallback, useRef } from 'react';

/**
 * Reads the per-challenge effective values + override flags that
 * ChallengeCard renders from. Bundles four related state slots that used
 * to live inline next to unrelated render logic, and exposes a
 * `toggleCompact()` action so the card no longer has to re-derive the
 * "no override → set override; has override → remove override" sequence
 * inline.
 *
 * Returns:
 *   hasCustomSettings   any perChallenge key has an override
 *   autoFillEnabled     effective autoFill value
 *   isCompact           effective compactCards value
 *   hasCompactOverride  whether compactCards has a per-challenge override
 *   toggleCompact()     flip the per-card density (or remove the override)
 *
 * `initialCompact` seeds isCompact until the IPC read lands — pass the global
 * compactCards default. Compact and detailed cards occupy different grid
 * spans, so a card that starts at the wrong density visibly reflows the whole
 * grid on every remount; with the seed only cards carrying an override flip.
 */
export function useChallengeSettings(challengeId, initialCompact = false) {
    const [hasCustomSettings, setHasCustomSettings] = useState(false);
    const [autoFillEnabled, setAutoFillEnabled] = useState(false);
    const [isCompact, setIsCompact] = useState(initialCompact);
    const [hasCompactOverride, setHasCompactOverride] = useState(false);

    // Tracks whether the card is still mounted. ChallengesSection refreshes
    // the challenge list on a timer and may unmount cards mid-reload (via the
    // `key={id-refreshKey}` strategy in that file). The flag prevents the
    // batch of setState calls from landing on an unmounted component.
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    // Walks the schema and sets the five state slots from current overrides.
    // Used by both the mount effect and toggleCompact so the
    // hasCustomSettings flag stays in sync after a per-challenge write.
    const reload = useCallback(async () => {
        const id = challengeId.toString();
        try {
            const { schema } = (await window.api.getSettingsSchema()) || {};
            if (!schema || !mountedRef.current) return;
            const perChallengeKeys = Object.entries(schema)
                .filter(([, config]) => config.perChallenge)
                .map(([key]) => key);
            const overrideResults = await Promise.all(
                perChallengeKeys.map((key) => window.api.getChallengeOverride(key, id)),
            );
            if (!mountedRef.current) return;
            setHasCustomSettings(overrideResults.some((o) => o !== null));

            const [fillOn, compact, compactOverride] = await Promise.all([
                window.api.getEffectiveSetting('autoFill', id),
                window.api.getEffectiveSetting('compactCards', id),
                window.api.getChallengeOverride('compactCards', id),
            ]);
            if (!mountedRef.current) return;
            setAutoFillEnabled(fillOn === true);
            setIsCompact(compact === true);
            setHasCompactOverride(compactOverride !== null);
        } catch {
            // Leave the previous values in place; the parent context
            // re-runs this effect when settings-changed fires.
        }
    }, [challengeId]);

    useEffect(() => {
        reload();
    }, [reload]);

    // First click sets a per-challenge override (opposite of current);
    // a second click on a card that already has an override removes it
    // (returns to global default). Reloads at the end so hasCustomSettings
    // tracks the new override-set membership.
    const toggleCompact = useCallback(async () => {
        const id = challengeId.toString();
        try {
            if (hasCompactOverride) {
                await window.api.removeChallengeOverride('compactCards', id);
            } else {
                await window.api.setChallengeOverride('compactCards', id, !isCompact);
            }
            await reload();
        } catch {
            // Leave UI as-is.
        }
    }, [challengeId, isCompact, hasCompactOverride, reload]);

    return {
        hasCustomSettings,
        autoFillEnabled,
        isCompact,
        hasCompactOverride,
        toggleCompact,
    };
}
