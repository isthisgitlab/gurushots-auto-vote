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

const V1_RENAME_TARGETS: ReadonlySet<string> = new Set(Object.values(V1_KEY_RENAMES));

/**
 * What a key named like a rename target (`autoSubmit`, ...) means in the map being renamed.
 *
 * - `drop-targets`: a map of a 1.x settings file. 1.x never read such a key, so it is a stray and goes, whether or
 *   not its 1.x counterpart is there.
 * - `keep-lone-targets`: a map from outside, such as a scenario file a 2.x install exported, which is already
 *   renamed. A target with no 1.x counterpart in the map is a 2.x name and stays; one beside its counterpart
 *   is a stray and goes.
 */
type RenameMode = 'drop-targets' | 'keep-lone-targets';

/**
 * A copy of a map with its renamed keys. Where a 1.x key and its 2.x name are both there the 1.x key wins; what a
 * lone 2.x name becomes depends on `mode`.
 */
const renameV1Keys = (values: V1Values, mode: RenameMode): V1Values => {
    const entries = Object.entries(values);
    const renamedTargets = new Set(entries.filter(([key]) => isRenamed(key)).map(([key]) => V1_KEY_RENAMES[key]));
    const isStray = (key: string) => V1_RENAME_TARGETS.has(key) && (mode === 'drop-targets' || renamedTargets.has(key));
    return Object.fromEntries(
        entries
            .filter(([key]) => !isStray(key))
            .map(([key, value]) => [isRenamed(key) ? V1_KEY_RENAMES[key] : key, value]),
    );
};

/**
 * A copy of `value` with its keys renamed when it is a plain object, else `value` itself.
 */
const renameV1Value = (value: unknown, mode: RenameMode): unknown =>
    isPlainObject(value) ? renameV1Keys(value, mode) : value;

/**
 * The name a stray 2.x key takes in a scenario phase's `settings` in `drop-targets` mode. Such a key made 1.x refuse
 * the whole document ("not a per-challenge setting"), so it is not dropped, which would make the document valid:
 * under this name no setting answers to it, so the document is refused as it was.
 */
const V1_REFUSED_KEY_PREFIX = 'ignored by 1.x: ';

const renamePhaseSettings = (settings: V1Values, mode: RenameMode): V1Values => {
    const renamed = renameV1Keys(settings, mode);
    if (mode === 'keep-lone-targets') return renamed;
    const strays = Object.keys(settings).filter((key) => V1_RENAME_TARGETS.has(key));
    return {
        ...renamed,
        ...Object.fromEntries(strays.map((key) => [`${V1_REFUSED_KEY_PREFIX}${key}`, settings[key]])),
    };
};

/**
 * A scenario document with the setting keys of every phase's `settings` renamed. For documents from outside the
 * app (a shared file: `keep-lone-targets`, the default) and for the ones in a 1.x settings file (`drop-targets`),
 * so it accepts anything: what is not a scenario-shaped object comes back as it is, nothing throws, and the input
 * is not changed.
 */
const renameV1ScenarioDocument = (doc: unknown, mode: RenameMode = 'keep-lone-targets'): unknown => {
    if (!isPlainObject(doc) || !isPlainObject(doc.phases)) return doc;
    const phases = Object.fromEntries(
        Object.entries(doc.phases).map(([name, phase]) => [
            name,
            isPlainObject(phase) && isPlainObject(phase.settings)
                ? { ...phase, settings: renamePhaseSettings(phase.settings, mode) }
                : phase,
        ]),
    );
    return { ...doc, phases };
};

export { V1_KEY_RENAMES, V1_REFUSED_KEY_PREFIX, renameV1Keys, renameV1ScenarioDocument, renameV1Value };
