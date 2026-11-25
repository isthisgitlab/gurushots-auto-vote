import { useCallback, useRef, useState } from 'react';
import { useLatestRef } from './useLatestRef';
import { editLinkedExposure, isExposureKey, resolveLinkedExposure } from '../../core/linkedExposure';

import type { ExposureKey } from '../../core/linkedExposure';
import type { ChallengeValues } from '../../core/types/settings';
import type { NumberEdit } from '../../core/types/settingsEditor';

type StagedEdit = {
    base: ChallengeValues;
    before: ChallengeValues;
    key: ExposureKey;
    displayed: number | undefined;
    value: unknown;
};

/** Use the values from the start of the edit so an intermediate digit cannot permanently move another field. */
export function useLinkedExposureChange(
    overrides: ChallengeValues,
    setOverrides: (values: ChallengeValues) => void,
    inherited: readonly ChallengeValues[],
) {
    const current = useLatestRef(overrides);
    const lowerLayers = useLatestRef(inherited);
    const effectiveExposure = resolveLinkedExposure([overrides, ...inherited]);
    const displayed = useLatestRef(effectiveExposure);
    const edit = useRef<{ session: object; before: ChallengeValues } | null>(null);
    const [staged, setStaged] = useState<StagedEdit | null>(null);
    // Invalidate the staged edit with the visible draft when a refresh replaces its value.
    const activeStage =
        staged?.base === overrides && staged.displayed === effectiveExposure[staged.key] ? staged : null;
    if (activeStage !== staged) setStaged(null);
    const valuesForSave = activeStage
        ? editLinkedExposure(activeStage.before, activeStage.key, activeStage.value, inherited)
        : overrides;
    const saveValues = useLatestRef(valuesForSave);
    const change = useCallback(
        (key: string, value: unknown, editAction?: NumberEdit): boolean => {
            if (!isExposureKey(key)) return false;
            if (editAction?.kind === 'clear') {
                setStaged(null);
                return true;
            }
            const session = editAction?.session;
            const before = edit.current && edit.current.session === session ? edit.current.before : current.current;
            edit.current = session ? { session, before } : null;
            if (editAction?.kind === 'stage') {
                setStaged({ base: current.current, before, key, displayed: displayed.current[key], value });
            } else {
                setStaged(null);
                setOverrides(editLinkedExposure(before, key, value, lowerLayers.current));
            }
            return true;
        },
        [current, displayed, lowerLayers, setOverrides],
    );
    const commitForSave = useCallback(() => {
        edit.current = null;
        const values = saveValues.current;
        setStaged(null);
        if (values !== current.current) setOverrides(values);
        return values;
    }, [current, saveValues, setOverrides]);
    return { change, effectiveExposure, valuesForSave, commitForSave };
}
