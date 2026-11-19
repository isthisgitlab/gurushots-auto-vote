import { useCallback, useEffect, useState } from 'react';
import * as ipc from './ipc';

import type { SubjectEntry } from '../../core/services/scenarioStatus';

type Kind = 'candidate' | 'active' | 'completed';

/**
 * The simulation subjects of one kind (list-simulation-subjects): what a what-if can run on. A list that cannot be
 * read is a failure with its own retry (it is not an empty list); `subjects: []` is a confirmed empty list, and `null`
 * is "not read yet". Only the newest read counts: an answer for a kind the user has since left, or for an attempt a retry
 * has replaced, is dropped, and `subjects` is only ever the list of the kind asked for.
 */
export function useSimulationSubjects(
    kind: Kind,
    enabled: boolean,
): {
    subjects: SubjectEntry[] | null;
    /** True when the read failed and can be retried. */
    failed: boolean;
    retry: () => void;
} {
    const [listing, setListing] = useState<{ kind: Kind; subjects: SubjectEntry[] } | null>(null);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    // A read answers only while its own effect run is the newest one (the kind, the attempt and `enabled` are what a run
    // belongs to): a later run, or leaving, retires it.
    const read = useCallback(
        async (isCurrent: () => boolean) => {
            const result = await ipc.callOrNull(() => ipc.listSimulationSubjects(kind));
            if (!isCurrent()) return;
            if (!result?.success || !result.readable) {
                setListing(null);
                setFailed(true);
                return;
            }
            setListing({ kind, subjects: result.subjects });
        },
        [kind],
    );

    useEffect(() => {
        if (!enabled) return undefined;
        let current = true;
        setListing(null);
        setFailed(false);
        void read(() => current);
        return () => {
            current = false;
        };
    }, [enabled, attempt, read]);

    return {
        subjects: listing?.kind === kind ? listing.subjects : null,
        failed,
        retry: () => setAttempt((n) => n + 1),
    };
}
