import { useCallback, useRef } from 'react';
import { useLatestRef } from './useLatestRef';
import { editLinkedExposure, isExposureKey } from '../../core/linkedExposure';

import type { ChallengeValues } from '../../core/types/settings';

/** Use the values from the start of the edit so an intermediate digit cannot permanently move another field. */
export function useLinkedExposureChange(
    overrides: ChallengeValues,
    setOverrides: (values: ChallengeValues) => void,
    inherited: readonly ChallengeValues[],
) {
    const current = useLatestRef(overrides);
    const lowerLayers = useLatestRef(inherited);
    const edit = useRef<{ session: object; before: ChallengeValues } | null>(null);
    return useCallback(
        (key: string, value: unknown, editSession?: object): boolean => {
            if (!isExposureKey(key)) return false;
            const before = edit.current && edit.current.session === editSession ? edit.current.before : current.current;
            edit.current = editSession ? { session: editSession, before } : null;
            setOverrides(editLinkedExposure(before, key, value, lowerLayers.current));
            return true;
        },
        [current, lowerLayers, setOverrides],
    );
}
