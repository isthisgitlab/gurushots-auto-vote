import { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react';
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
 *   autoSubmitEnabled     effective autoSubmit value
 *   manualPhotosOnly    effective manualPhotosOnly value
 *   isCompact           effective compactCards value
 *   hasCompactOverride  whether compactCards has a per-challenge override
 *   unavailableReason   why the challenge's settings cannot be read (its scenario phase needs settings that were not
 *                       published), else null; the values above then stay as they were, never an "off" read
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
export function useChallengeSettings(
    challengeId: string | number,
    initialCompact: boolean = false,
    settingsVersion: number = 0,
) {
    const [hasCustomSettings, setHasCustomSettings] = useState(false);
    const [autoSubmitEnabled, setAutoSubmitEnabled] = useState(false);
    const [manualPhotosOnly, setManualPhotosOnly] = useState(false);
    const [isCompact, setIsCompact] = useState(initialCompact);
    const [hasCompactOverride, setHasCompactOverride] = useState(false);
    const [unavailableReason, setUnavailableReason] = useState<string | null>(null);

    // Whether the card is still mounted; a reload settling after unmount applies nothing.
    const mountedRef = useRef(true);
    // Only the newest reload may apply: broadcasts can start overlapping
    // reloads, and an older one settling last must not overwrite newer values.
    const reloadIdRef = useRef(0);
    useLayoutEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    // Reloads the state slots from the current overrides.
    const reload = useCallback(async () => {
        const id = challengeId.toString();
        const reloadId = ++reloadIdRef.current;
        const current = () => mountedRef.current && reloadId === reloadIdRef.current;
        try {
            // One read of the sparse override map (per-challenge keys only), not one per key.
            const overrides = await ipc.getChallengeOverrides(id);
            if (!overrides || !current()) return;
            setHasCustomSettings(Object.values(overrides).some((o) => o !== null));
            setHasCompactOverride((overrides.compactCards ?? null) !== null);

            const [fillOn, manualOnly, compact] = await Promise.all([
                ipc.getEffectiveSetting('autoSubmit', id),
                ipc.getEffectiveSetting('manualPhotosOnly', id),
                ipc.getEffectiveSetting('compactCards', id),
            ]);
            if (!current()) return;
            // Each of these is a boolean whenever it can be read: anything else is an unavailable challenge (the channel
            // answers null for a setting that cannot be read), which must not show as "off".
            if ([fillOn, manualOnly, compact].some((value) => typeof value !== 'boolean')) {
                const status = await ipc.getScenarioStatus(id);
                if (!current()) return;
                setUnavailableReason(status?.success ? (status.overlay.reason ?? 'unavailable') : 'unavailable');
                return;
            }
            setUnavailableReason(null);
            setAutoSubmitEnabled(fillOn === true);
            setManualPhotosOnly(manualOnly === true);
            setIsCompact(compact === true);
        } catch {
            // Leave the previous values in place; the parent context
            // re-runs this effect when settings-changed fires.
        }
    }, [challengeId]);

    useEffect(() => {
        void reload();
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
        autoSubmitEnabled,
        manualPhotosOnly,
        isCompact,
        hasCompactOverride,
        unavailableReason,
        toggleCompact,
    };
}
