/**
 * The 2.x setting-key renames and where they apply. In 1.x `autoFill*` / `emergencyFill*` named submitting a photo
 * while "fill" in the UI and in other keys named a currency; 2.x spells the photo submission "submit". Only keys
 * change, never values.
 */

import { isPlainObject } from '../../plainObject';

import type { V1Values } from './types';

/** 1.x key to 2.x key. The currency keys (`autoExposureFill*`, `scheduledFill*`, ...) and `scenario` keep their names. */
const V1_KEY_RENAMES: Readonly<Record<string, string>> = Object.freeze({
    autoFill: 'autoSubmit',
    autoFillSchedule: 'autoSubmitSchedule',
    emergencyFill: 'emergencySubmit',
    protectUncertainAutoFills: 'protectUncertainAutoSubmits',
    fillWithoutTagMatch: 'submitWithoutTagMatch',
    notifyOnAutoFill: 'notifyOnAutoSubmit',
    notifyOnEmergencyFill: 'notifyOnEmergencySubmit',
    boostFillNew: 'boostNewSubmit',
    boostFillNewOnConflict: 'boostNewSubmitOnConflict',
    turboFillNew: 'turboNewSubmit',
    turboFillNewOnConflict: 'turboNewSubmitOnConflict',
});

const isRenamed = (key: string): boolean => Object.hasOwn(V1_KEY_RENAMES, key);

/**
 * A copy of a map with its renamed keys. A 1.x key wins over a 2.x-named key already in the map: 1.x never read
 * the latter, so it is a leftover.
 */
const renameV1Keys = (values: V1Values): V1Values => {
    const entries = Object.entries(values);
    const targets = new Set(entries.filter(([key]) => isRenamed(key)).map(([key]) => V1_KEY_RENAMES[key]));
    return Object.fromEntries(
        entries
            .filter(([key]) => !targets.has(key))
            .map(([key, value]) => [isRenamed(key) ? V1_KEY_RENAMES[key] : key, value]),
    );
};

/**
 * A copy of `value` with its keys renamed when it is a plain object, else `value` itself.
 */
const renameV1Value = (value: unknown): unknown => (isPlainObject(value) ? renameV1Keys(value) : value);

/**
 * A 1.x scenario document with the setting keys of every phase's `settings` renamed. For documents from outside the
 * app (a shared file), so it accepts anything: what is not a scenario-shaped object comes back as it is, nothing
 * throws, and the input is not changed.
 */
const renameV1ScenarioDocument = (doc: unknown): unknown => {
    if (!isPlainObject(doc) || !isPlainObject(doc.phases)) return doc;
    const phases = Object.fromEntries(
        Object.entries(doc.phases).map(([name, phase]) => [
            name,
            isPlainObject(phase) && isPlainObject(phase.settings)
                ? { ...phase, settings: renameV1Keys(phase.settings) }
                : phase,
        ]),
    );
    return { ...doc, phases };
};

export { V1_KEY_RENAMES, renameV1Keys, renameV1ScenarioDocument, renameV1Value };
