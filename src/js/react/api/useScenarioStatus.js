import { useEffect, useState } from 'react';
import { nextWakeAt } from '../../scenarios/nextWake';
import { useLatestRef } from '../hooks/useLatestRef';
import * as ipc from './ipc';

/**
 * A card-sized summary of where a challenge is in its scenario, or null when
 * it has none. `nextWakeAt` is computed here with the engine's own wake-up
 * math, so the card shows the same moment the scheduler wakes for.
 *
 * Keyed on a fingerprint of the challenge fields a scenario step changes
 * (entries, boost/turbo state) plus `settingsVersion`, so it refetches after
 * a pass that did something, not on every render.
 *
 * @param {any} challenge - the card's challenge (always present)
 * @param {number} [settingsVersion]
 * @returns {null | {name: string, missing?: true, corrupt?: true, phase?: string, started?: boolean, lastError?: string|null, nextWakeAt?: number|null}}
 */
export function useScenarioStatus(challenge, settingsVersion) {
    const [summary, setSummary] = useState(null);
    const entries = challenge.member?.ranking?.entries;
    const fingerprint = [
        challenge.id,
        challenge.close_time,
        challenge.member?.boost?.state,
        challenge.member?.turbo?.state,
        Array.isArray(entries) ? entries.map((e) => `${e?.id}:${e?.votes}:${e?.rank}`).join(',') : '',
    ].join('|');
    const challengeRef = useLatestRef(challenge);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const current = challengeRef.current;
            let next = null;
            try {
                const status = await ipc.getScenarioStatus(current.id);
                if (status?.success && status.assigned) next = summarize(status, current);
            } catch {
                next = null;
            }
            if (!cancelled) setSummary(next);
        })();
        return () => {
            cancelled = true;
        };
    }, [fingerprint, settingsVersion, challengeRef]);

    return summary;
}

function summarize(status, challenge) {
    if (!status.scenario) return { name: status.assigned, missing: true };
    if (status.corrupt) return { name: status.scenario.name, corrupt: true };
    const now = Math.floor(Date.now() / 1000);
    const state = status.state ?? { phase: status.scenario.start, phaseEnteredAt: now, fired: {}, memory: {} };
    return {
        name: status.scenario.name,
        phase: state.phase,
        started: status.state !== null,
        lastError: status.state?.lastError?.message ?? null,
        nextWakeAt: nextWakeAt({ scenario: status.scenario, state, challenge, now, timezone: status.timezone }),
    };
}
