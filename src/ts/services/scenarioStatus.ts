/**
 * Where a challenge is in its assigned scenario — one read shared by the
 * Node-side scheduler resolver (scheduling/nodeResolvers.ts), the
 * get-scenario-status IPC channel (the GUI's resolver and status line) and
 * the CLI. Reads only; the runner (scenarioRunner.ts) is the only writer.
 */

import * as settings from '../settings';
import { DEFAULT_TIMEZONE } from '../settings/uiDefaults';
import { scenarioStateLedger, mockScenarioStateLedger, scenarioStepLock } from '../scenarioStateStore';

import type { ScenarioState } from '../types/stores';
import type { ScenarioDocument } from '../settings/scenarioSchema';
import type { ScenarioStateLedger } from '../types/votingPass';

/**
 * Mock mode keeps scenario state in memory — the same process-wide ledger the
 * mock voting pass writes.
 */
const ledgerForMode = () => (settings.getSetting('mock') === true ? mockScenarioStateLedger : scenarioStateLedger);

/**
 * The lock a reset of one challenge's progress takes, so it never runs in the middle of that challenge's rule steps
 * in another process. Mock mode has no other process, and no lock.
 */
const stepLockForMode = (challengeId: string | number) =>
    settings.getSetting('mock') === true ? { ok: true, release: () => {} } : scenarioStepLock(challengeId);

/**
 * @param ledger - defaults to the ledger for the current mode
 *   `assigned` is the challenge's `scenario` setting ('' = none); `scenario`
 *   is null when that name is unknown; `state` is null until the plan starts
 *   (or when it belongs to another scenario); `corrupt` means unreadable state.
 */
const getScenarioStatus = (
    challengeId: string | number,
    ledger: ScenarioStateLedger = ledgerForMode(),
): {
    assigned: string;
    scenario: ScenarioDocument | null;
    state: ScenarioState | null;
    corrupt: false | 'file' | 'record';
    timezone: string;
} => {
    const id = String(challengeId);
    const timezone = settings.getSetting('timezone') || DEFAULT_TIMEZONE;
    const assigned = settings.getEffectiveSetting('scenario', id) || '';
    const scenario = assigned ? settings.getScenario(assigned) : null;
    if (!scenario) return { assigned, scenario: null, state: null, corrupt: false, timezone };
    const { corrupt, state } = ledger.get(id);
    const current = state && state.scenario.toLowerCase() === scenario.name.toLowerCase() ? state : null;
    return { assigned, scenario, state: current, corrupt, timezone };
};

/**
 * The input the scheduler's scenario boundary needs, or null when nothing can
 * run for this challenge (no known scenario, or unreadable state).
 */
const scenarioWakeInput = ({
    scenario,
    state,
    corrupt,
    timezone,
}: {
    scenario: ScenarioDocument | null;
    state: ScenarioState | null;
    corrupt: false | 'file' | 'record';
    timezone: string;
}) => (scenario && !corrupt ? { scenario, state, timezone } : null);

export { getScenarioStatus, scenarioWakeInput, ledgerForMode, stepLockForMode };
