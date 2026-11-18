/**
 * Where a challenge is in its assigned scenario — one read shared by the
 * Node-side scheduler resolver (scheduling/nodeResolvers.ts), the
 * get-scenario-status IPC channel (the GUI's resolver and status line) and
 * the CLI. Reads only; the runner (scenarioRunner.ts) is the only writer.
 */

import * as settings from '../settings';
import { captureInstallationTimezone } from './installationTimezone';
import { scenarioStateLedger, mockScenarioStateLedger, scenarioStepLock } from '../scenarioStateStore';
import { readCompletedChallenges } from './autoClaim';
import { isMarkedChallenge } from '../challengeMarks';

import type { ApiStrategy } from '../apiFactory';
import type { Challenge, CompletedChallenge } from '../types/gurushots';
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
 *   (or when it belongs to another scenario); `corrupt` means unreadable state (`unloaded`: not read in yet);
 *   `timezone` is the installation's effective zone read now, and '' when it cannot be read (a zone is never empty
 *   otherwise): the saved zone never takes its place, and no time boundary is worked out from it.
 */
const getScenarioStatus = (
    challengeId: string | number,
    ledger: ScenarioStateLedger = ledgerForMode(),
): {
    assigned: string;
    scenario: ScenarioDocument | null;
    state: ScenarioState | null;
    corrupt: false | 'file' | 'record' | 'unloaded';
    timezone: string;
} => {
    const id = String(challengeId);
    const timezone = captureInstallationTimezone() ?? '';
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
    corrupt: false | 'file' | 'record' | 'unloaded';
    timezone: string;
}) => (scenario && !corrupt && timezone !== '' ? { scenario, state, timezone } : null);

/** The kinds of challenge a simulation can run on, each listed from its own producer. */
type SubjectKind = 'candidate' | 'active' | 'completed';

/** The producers a subject list reads: the active list, the open (not yet joined) list and the completed list. */
type SubjectProducers = Pick<ApiStrategy, 'getActiveChallenges' | 'getMemberChallenges' | 'getMyCompletedChallenges'>;

/**
 * The rows one producer lists for a kind of subject, or that it could not be read (`readable: false`: a failed read, which is not
 * an empty list). `pruneUnsafe`: the active read dropped rows, so a row that is not listed may be one of them.
 */
type SubjectRows =
    | { readable: false }
    | { readable: true; kind: 'active'; rows: Challenge[]; pruneUnsafe: boolean }
    | { readable: true; kind: 'candidate'; rows: Challenge[]; pruneUnsafe: false }
    | { readable: true; kind: 'completed'; rows: CompletedChallenge[]; pruneUnsafe: false };

/**
 * Reads the list a kind of subject comes from, through the existing read-only producers. Never joins, claims or spends
 * anything: a preview is made from what is already there.
 */
const readSubjectRows = async (kind: SubjectKind, token: string, producers: SubjectProducers): Promise<SubjectRows> => {
    if (kind === 'active') {
        const response = await producers.getActiveChallenges(token);
        if (!response || response.fetchFailed || !Array.isArray(response.challenges)) return { readable: false };
        return { readable: true, kind, rows: response.challenges, pruneUnsafe: response.pruneUnsafe === true };
    }
    if (kind === 'candidate') {
        const rows = await producers.getMemberChallenges(token, 'open');
        return Array.isArray(rows) ? { readable: true, kind, rows, pruneUnsafe: false } : { readable: false };
    }
    const listing = await readCompletedChallenges(token, producers);
    return listing.failedPage === null
        ? { readable: true, kind, rows: listing.challenges, pruneUnsafe: false }
        : { readable: false };
};

/** A subject as a list shows it: its id and a short label. */
type SubjectEntry = { id: string; label: string };

const LABEL_LENGTH = 120;

/**
 * The subjects a simulation can run on for one kind, as `{id, label}` entries, with the read's health: `readable: false` means
 * the list could not be read (shown as a failure to retry); `readable: true` with no entries is a confirmed empty list.
 */
const listSimulationSubjects = async (
    kind: SubjectKind,
    token: string,
    producers: SubjectProducers,
): Promise<{ readable: boolean; subjects: SubjectEntry[] }> => {
    const read = await readSubjectRows(kind, token, producers);
    if (!read.readable) return { readable: false, subjects: [] };
    // A challenge marked as having unreadable data is not offered: a preview would judge it on what cannot be read.
    const rows: Array<Challenge | CompletedChallenge> =
        read.kind === 'completed' ? read.rows : read.rows.filter((row) => !isMarkedChallenge(row));
    const subjects = rows.flatMap((row) => {
        if (row?.id === undefined || row.id === null) return [];
        const id = String(row.id);
        return [{ id, label: String(row.title ?? id).slice(0, LABEL_LENGTH) }];
    });
    return { readable: true, subjects };
};

export {
    getScenarioStatus,
    scenarioWakeInput,
    ledgerForMode,
    stepLockForMode,
    listSimulationSubjects,
    readSubjectRows,
};
export type { SubjectEntry, SubjectKind, SubjectProducers, SubjectRows };
