import { useEffect, useState } from 'react';
import { nextWakeAt } from '../../scenarios/nextWake';
import { startState } from '../../scenarios/evaluate';
import { useLatestRef } from '../hooks/useLatestRef';
import * as ipc from './ipc';

import type { Challenge } from '../../types/gurushots';
import type { WindowApi } from '../../types/ipc';

/**
 * A challenge's scenario position as the card shows it.
 */
export type ScenarioSummary = {
    name: string;
    missing?: true;
    corrupt?: true;
    phase?: string;
    started?: boolean;
    lastError?: string | null;
    nextWakeAt?: number | null;
};

type ScenarioStatus = Extract<Awaited<ReturnType<WindowApi['getScenarioStatus']>>, { success: true }>;

/**
 * A card-sized summary of where a challenge is in its scenario, or null when
 * it has none. `nextWakeAt` is computed here with the engine's own wake-up
 * math, so the card shows the same moment the scheduler wakes for.
 *
 * Keyed on a fingerprint of the challenge fields a scenario step changes
 * (entries, boost/turbo state), `settingsVersion`, and `passVersion` — bumped
 * when a voting pass finishes, since a pass can start a scenario, change its
 * phase or send a notice without touching the challenge payload. So it
 * refetches after a pass or an edit, not on every render.
 *
 * @param challenge - the card's challenge (always present)
 */
export function useScenarioStatus(
    challenge: Challenge,
    settingsVersion?: number,
    passVersion?: number,
): ScenarioSummary | null {
    const [summary, setSummary] = useState<ScenarioSummary | null>(null);
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
            let next: ScenarioSummary | null = null;
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
    }, [fingerprint, settingsVersion, passVersion, challengeRef]);

    return summary;
}

/**
 * @param status - an assigned challenge's status
 */
function summarize(status: ScenarioStatus, challenge: Challenge): ScenarioSummary {
    if (!status.scenario) return { name: status.assigned, missing: true };
    if (status.corrupt) return { name: status.scenario.name, corrupt: true };
    const now = Math.floor(Date.now() / 1000);
    const state = status.state ?? startState(status.scenario, now);
    return {
        name: status.scenario.name,
        phase: state.phase,
        started: status.state !== null,
        lastError: status.state?.lastError?.message ?? null,
        nextWakeAt: nextWakeAt({ scenario: status.scenario, state, challenge, now, timezone: status.timezone }),
    };
}
