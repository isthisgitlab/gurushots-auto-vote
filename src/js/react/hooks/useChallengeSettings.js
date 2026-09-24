import { useEffect, useState, useCallback, useRef } from 'react';
import * as ipc from '@/api/ipc';

/**
 * Reads the per-challenge effective values + override flags that
 * ChallengeCard renders from. Bundles four related state slots and
 * exposes a `toggleCompact()` action so the card doesn't have to re-derive
 * the "no override → set override; has override → remove override"
 * sequence inline.
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
 *
 * `settingsVersion` changes when a settings-changed broadcast arrives; the
 * values are then re-read in place, without remounting the card.
 */
export function useChallengeSettings(challengeId, initialCompact = false, settingsVersion = 0) {
    const [hasCustomSettings, setHasCustomSettings] = useState(false);
    const [autoFillEnabled, setAutoFillEnabled] = useState(false);
    const [isCompact, setIsCompact] = useState(initialCompact);
    const [hasCompactOverride, setHasCompactOverride] = useState(false);

    // Tracks whether the card is still mounted: a challenge leaving the list
    // unmounts its card mid-reload, and the flag keeps the batch of setState
    // calls from landing on an unmounted component.
    const mountedRef = useRef(true);
    // Only the newest reload may apply: broadcasts can start overlapping
    // reloads, and an older one settling last must not overwrite newer values.
    const reloadIdRef = useRef(0);
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
        const reloadId = ++reloadIdRef.current;
        const current = () => mountedRef.current && reloadId === reloadIdRef.current;
        try {
            const { schema } = (await ipc.getSettingsSchema()) || {};
            if (!schema || !current()) return;
            const perChallengeKeys = Object.entries(schema)
                .filter(([, config]) => config.perChallenge)
                .map(([key]) => key);
            const overrideResults = await Promise.all(perChallengeKeys.map((key) => ipc.getChallengeOverride(key, id)));
            if (!current()) return;
            setHasCustomSettings(overrideResults.some((o) => o !== null));

            const [fillOn, compact, compactOverride] = await Promise.all([
                ipc.getEffectiveSetting('autoFill', id),
                ipc.getEffectiveSetting('compactCards', id),
                ipc.getChallengeOverride('compactCards', id),
            ]);
            if (!current()) return;
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
    }, [reload, settingsVersion]);

    // First click sets a per-challenge override (opposite of current);
    // a second click on a card that already has an override removes it
    // (returns to global default). Reloads at the end so hasCustomSettings
    // tracks the new override-set membership.
    const toggleCompact = useCallback(async () => {
        const id = challengeId.toString();
        try {
            if (hasCompactOverride) {
                await ipc.removeChallengeOverride('compactCards', id);
            } else {
                await ipc.setChallengeOverride('compactCards', id, !isCompact);
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
