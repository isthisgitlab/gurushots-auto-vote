import { useEffect, useState } from 'react';
import { signal } from '@preact/signals';
import { nextWakeAt } from '../../scenarios/nextWake';
import { startState } from '../../scenarios/evaluate';
import { useLatestRef } from '../hooks/useLatestRef';
import * as ipc from './ipc';

import type { Challenge } from '../../types/gurushots';
import type { WindowApi } from '../../types/ipc';
import type { ScenarioState, SpendAction } from '../../types/stores';
import type { ScenarioDocument } from '../../settings/scenarioSchema';

// Bumped when scenario progress was reset (one challenge's or every challenge's): every card reads its status again.
const scenarioResets = signal(0);

/**
 * Tells every card that scenario progress changed, so each reads its own status again.
 */
export const refreshScenarioStatuses = () => {
    scenarioResets.value += 1;
};

/**
 * A challenge's scenario position as the card shows it.
 */
export type ScenarioSummary = {
    name: string;
    missing?: true;
    /**
     * The saved progress cannot be read: all of it (`file`), or this challenge's record (`record`); or it was not read
     * in yet (`unloaded`: nothing is known of it, and nothing is reset).
     */
    corrupt?: 'file' | 'record' | 'unloaded';
    /** With `unloaded`: the background service keeps running the plans, so only this window lacks the progress. */
    serviceRuns?: boolean;
    phase?: string;
    started?: boolean;
    lastError?: string | null;
    /**
     * A spend that got no answer, which the line words with the action's own label: the rule that will check on it
     * (`stopped` false), or the rule that was stopped so that it is never spent again (`stopped` true), when that
     * rule can run again (`again`: the phase entered again, a reset, or the next day, by its repeat mode) and the
     * challenge a reset is named for. `newerProblem`: a problem came after the stop, and is shown beside it.
     */
    spendUnclear?: {
        action: SpendAction;
        stopped: boolean;
        again: 'phase' | 'reset' | 'day';
        challengeId: Challenge['id'];
        newerProblem: boolean;
        /** What the stop came from: GuruShots giving no answer, or the app stopping before it knew (`pending`). */
        origin: 'unclear' | 'pending';
    } | null;
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
    // Read while rendering, so a reset anywhere renders this card again.
    const resets = scenarioResets.value;

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
    }, [fingerprint, settingsVersion, passVersion, resets, challengeRef]);

    return summary;
}

const AGAIN: Record<string, 'phase' | 'reset' | 'day'> = { once: 'reset', oncePerDay: 'day' };

/**
 * The spend that got no answer which the card should say so about: the one being checked on (carried by the rule
 * in flight), else the one a rule was stopped after in the phase it is in now, with when that rule can run again.
 */
const spendUnclearOf = (
    state: Pick<ScenarioState, 'inFlight' | 'fired' | 'phaseEnteredAt' | 'lastError'>,
    scenario: ScenarioDocument,
    challengeId: Challenge['id'],
): ScenarioSummary['spendUnclear'] => {
    const base = { challengeId, again: 'phase' as const, newerProblem: false, origin: 'unclear' as const };
    // One spend is shown even when an edit left several (they are all kept; the first is what the notice names).
    const [checkedOn] = state.inFlight?.unclear ?? [];
    if (checkedOn !== undefined) {
        return {
            ...base,
            action: checkedOn,
            stopped: false,
            // The app, not GuruShots, did not know, when the marker came from one the app absorbed.
            origin: state.inFlight?.lost?.includes(checkedOn) ? ('pending' as const) : ('unclear' as const),
            newerProblem: (state.lastError?.at ?? 0) > (state.inFlight?.unclearAt ?? Infinity),
        };
    }
    const [stopped] = Object.entries(state.fired).flatMap(([ruleId, record]) =>
        record.unclearHalt !== undefined && record.phaseEnteredAt === state.phaseEnteredAt
            ? [{ ruleId, action: record.unclearHalt, at: record.at, origin: record.haltOrigin ?? ('unclear' as const) }]
            : [],
    );
    if (stopped === undefined) return null;
    const rule = Object.values(scenario.phases)
        .flatMap((phase) => phase.rules ?? [])
        .find((candidate) => candidate.id === stopped.ruleId);
    return {
        ...base,
        action: stopped.action,
        stopped: true,
        origin: stopped.origin,
        again: AGAIN[rule?.repeat ?? ''] ?? 'phase',
        newerProblem: (state.lastError?.at ?? 0) > stopped.at,
    };
};

/**
 * @param status - an assigned challenge's status
 */
function summarize(status: ScenarioStatus, challenge: Challenge): ScenarioSummary {
    if (!status.scenario) return { name: status.assigned, missing: true };
    if (status.corrupt) return { name: status.scenario.name, corrupt: status.corrupt, serviceRuns: status.serviceRuns };
    const now = Math.floor(Date.now() / 1000);
    const state = status.state ?? startState(status.scenario, now);
    return {
        name: status.scenario.name,
        phase: state.phase,
        started: status.state !== null,
        lastError: status.state?.lastError?.message ?? null,
        spendUnclear: spendUnclearOf(state, status.scenario, challenge.id),
        nextWakeAt: nextWakeAt({ scenario: status.scenario, state, challenge, now, timezone: status.timezone }),
    };
}
