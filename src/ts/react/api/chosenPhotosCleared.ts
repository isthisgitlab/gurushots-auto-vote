import { useLayoutEffect } from 'react';
import { useLatestRef } from '@/hooks/useLatestRef';

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
 * mounted. The latest callback is used, so it needs no stable identity.
 */
export function useOnChosenPhotosCleared(onCleared: () => void): void {
    const latest = useLatestRef(onCleared);
    useLayoutEffect(() => {
        const listen = () => latest.current();
        listeners.add(listen);
        return () => {
            listeners.delete(listen);
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
