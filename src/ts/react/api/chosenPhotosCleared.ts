import { useLayoutEffect } from 'react';
import { useLatestRef } from '@/hooks/useLatestRef';
import * as ipc from './ipc';
import { isPlainObject } from '../../plainObject';

import type { ScenarioDraft } from '../../types/scenarioBuilder';

// Editors hold their own drafts (rules, overrides, global values, a scenario). When
// every saved chosen-photos list is removed behind their back, a later Save of
// such a draft would write the lists back — and stamp the signed-in account as
// their owner. The removal is announced here so each open draft drops them.
const listeners = new Set<() => void>();

/** Tell every open draft that every saved chosen-photos list was just removed. */
export const announceChosenPhotosCleared = (): void => {
    listeners.forEach((listen) => listen());
};

/**
 * Run `onCleared` whenever the saved lists are removed while this component is
 * mounted: by the chooser's removal button (announced directly), or by a removal
 * made elsewhere — the CLI, another window — which reaches this window through the
 * settings-changed broadcast (`chosenPhotosClearedAt` moves past the moment this
 * component mounted). The latest callback is used, so it needs no stable identity.
 */
export function useOnChosenPhotosCleared(onCleared: () => void): void {
    const latest = useLatestRef(onCleared);
    useLayoutEffect(() => {
        const listen = () => latest.current();
        listeners.add(listen);
        // Both clocks are this machine's, so "after I mounted" is comparable.
        const mountedAt = Date.now();
        let announcedAt = 0;
        const unsubscribe = ipc.onSettingsChanged?.((settings: unknown) => {
            const stamp = isPlainObject(settings) ? settings.chosenPhotosClearedAt : undefined;
            const clearedAt = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN;
            if (clearedAt > mountedAt && clearedAt > announcedAt) {
                announcedAt = clearedAt;
                listen();
            }
        });
        return () => {
            listeners.delete(listen);
            unsubscribe?.();
        };
    }, [latest]);
}

/** A values map without its `chosenPhotos` list (the same map when it holds none). */
export const withoutChosenPhotos = <T extends Record<string, unknown>>(values: T): T => {
    if (!Object.prototype.hasOwnProperty.call(values, 'chosenPhotos')) return values;
    const rest = { ...values };
    delete rest.chosenPhotos;
    return rest;
};

/** A values map with an empty `chosenPhotos` list in place of its list (the same map when it holds none). */
export const withEmptyChosenPhotos = <T extends Record<string, unknown>>(values: T): T =>
    Object.prototype.hasOwnProperty.call(values, 'chosenPhotos') ? { ...values, chosenPhotos: [] } : values;

/** A scenario draft with every phase's settings stripped of `chosenPhotos`. */
export const scenarioWithoutChosenPhotos = (draft: ScenarioDraft): ScenarioDraft => ({
    ...draft,
    phases: Object.fromEntries(
        Object.entries(draft.phases).map(([name, phase]) => [
            name,
            phase.settings ? { ...phase, settings: withoutChosenPhotos(phase.settings) } : phase,
        ]),
    ),
});
