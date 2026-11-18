/**
 * The installation scenario's publication: the one overlay of its current phase (the phase's literals, and its bindings
 * resolved), written into the `@installation` record of the scenario ledger. Every consumer of an installation setting
 * reads it through the settings facade (getInstallationSetting); none of them evaluates anything.
 *
 * Only the runtime the assignment names (`installationScenario.executor`, the platform's `capabilities.executor`) publishes,
 * at the start of its cycle, before the mission read and the join and claim pre-steps. Any other runtime reads what the
 * owner published and never writes it. The write is made under the installation's step lock and carries the owner
 * generation: a former owner, whose generation the assignment has left, is refused and stops. Bindings are worked out from
 * the saved settings and the raw account evidence under the saved transport policy (loadAccountEvidence): that evidence is
 * what a binding is worked out from, so it cannot wait for the policy the binding may overlay.
 *
 * Nothing here runs a rule, changes a phase or spends anything: that is the installation runner's (a later package).
 */

import * as settings from '../../settings';
import { errorMessage } from '../../errorMessage';
import { platform } from '../../platform/port';
import { effectiveTimezone } from '../../settings/uiDefaults';
import { evaluateExpression } from '../../scenarios/expressions';
import { INSTALLATION_KEY, initialState } from '../../scenarioStateStore';
import type { StateLock } from '../../scenarioStateStore';
import type { Challenge } from '../../types/gurushots';
import type { ExpressionContext } from '../../scenarios/expressions';
import type { ScenarioPublication, ScenarioState } from '../../types/stores';
import type { ScenarioStateLedger } from '../../types/votingPass';
import { evidenceNeeded, loadAccountEvidence } from './facts';
import type { AccountReads } from './facts';
import { withNotice } from './rule';
import { nextBindingInstant } from './step';
import { log, nowSec } from './support';

const NO_LOCK: StateLock = { ok: true, release: () => {} };

/**
 * What the installation's publication step needs of the cycle: the token, the ledger (the persisted one, or the mock run's
 * in-memory one), the cross-process lock of the installation's steps (absent where one process runs them: mock mode), and
 * the read-only account endpoints its bindings read.
 */
type InstallationPass = {
    token: string;
    ledger: ScenarioStateLedger;
    lock?: (key: string) => StateLock;
    reads: Pick<AccountReads, 'getBankroll' | 'getMyMissions' | 'getMyCompletedChallenges'>;
};

/**
 * What the step did: `none` (no installation scenario that runs), `not-owner` (another runtime owns it), `stale` (the
 * assignment is at another generation, or the record is not this scenario's: nothing is written), `held` (paused, or a
 * handoff not finished), `busy` (another process holds the step), `unreadable` (the progress cannot be read), `blocked`
 * (the phase could not be prepared: its publication is cleared and the reason recorded), `published`, `cleared` (the
 * phase sets nothing: no publication stands) and `failed` (a write did not land).
 */
type InstallationPublishStatus =
    | 'none'
    | 'not-owner'
    | 'stale'
    | 'held'
    | 'busy'
    | 'unreadable'
    | 'blocked'
    | 'published'
    | 'cleared'
    | 'failed';

/**
 * The challenge the installation has in the fact snapshot an expression reads: an installation scenario reads no challenge
 * (the registry offers it only account facts), so this is the shape the snapshot needs and nothing else.
 */
const NO_CHALLENGE: Challenge = {
    id: INSTALLATION_KEY,
    title: '',
    start_time: 0,
    close_time: 0,
    entries: 0,
    players: 0,
};

const withoutPublication = (state: ScenarioState): ScenarioState => {
    const rest = { ...state };
    delete rest.published;
    delete rest.publicationUnreadable;
    return rest;
};

/** The words of a phase whose settings could not be prepared, for the halt notice. */
const blockedText = (phase: string, key: string | null, reason: string): string =>
    key === null ? `phase ${phase}: ${reason}` : `phase ${phase}: ${key}: ${reason}`;

type Prepared =
    | { ok: true; publication: ScenarioPublication | null }
    | { ok: false; key: string | null; reason: string };

/**
 * Publishes the installation's overlay for the current phase, when this runtime is the owner. Never throws.
 */
const publishInstallationOverlay = async (pass: InstallationPass): Promise<InstallationPublishStatus> => {
    try {
        return await publishUnderOwnership(pass);
    } catch (error) {
        log().error(`installation settings could not be published: ${errorMessage(error) || error}`, null);
        return 'failed';
    }
};

const publishUnderOwnership = async (pass: InstallationPass): Promise<InstallationPublishStatus> => {
    // The assignment first: an installation with none costs nothing, and the progress record is not read.
    const assignment = settings.getInstallationScenario();
    if (!assignment) return 'none';
    if (platform().capabilities.executor !== assignment.executor) return 'not-owner';
    const scenario = settings.getScenario(assignment.scenario);
    if (!scenario || scenario.scope !== 'installation') return 'none';
    const generation = settings.installationGeneration();
    // A generation the assignment has not reached (a change that was begun and not finished) is not one to publish under.
    if (generation === null) return 'unreadable';
    if (generation !== assignment.generation) return 'stale';

    const lock = pass.lock ? pass.lock(INSTALLATION_KEY) : NO_LOCK;
    if (!lock.ok) return 'busy';
    try {
        const { corrupt, state } = pass.ledger.get(INSTALLATION_KEY);
        if (corrupt) return 'unreadable';
        if (state?.paused || state?.handoff) return 'held';
        if (state && state.scenario.toLowerCase() !== scenario.name.toLowerCase()) return 'stale';
        const now = nowSec();
        const phase = state?.phase ?? scenario.start;
        const phaseEnteredAt = state?.phaseEnteredAt ?? now;
        if (!scenario.phases[phase]) return 'none';

        const at = { phase, phaseEnteredAt, published: state?.published };
        const prepared = await prepare(pass, scenario, at, state, generation, now);
        return write(pass, scenario.name, at, prepared, generation, now);
    } finally {
        lock.release();
    }
};

const prepare = async (
    pass: InstallationPass,
    scenario: NonNullable<ReturnType<typeof settings.getScenario>>,
    at: Pick<ScenarioState, 'phase' | 'phaseEnteredAt' | 'published'>,
    state: ScenarioState | null,
    generation: number,
    now: number,
): Promise<Prepared> => {
    const phase = scenario.phases[at.phase];
    const bindings = phase.bindings ?? {};
    // Only the evidence the bindings read is fetched; none for a phase that has none.
    const evidence = await loadAccountEvidence(evidenceNeeded(scenario, at.phase, false), {
        subject: 'the installation',
        token: pass.token,
        ...pass.reads,
    });
    const timezone = effectiveTimezone(settings.getSetting('timezone'));
    return settings.prepareInstallationSnapshot(
        scenario,
        at,
        (readBase) => {
            const facts: ExpressionContext = {
                challenge: NO_CHALLENGE,
                state: { phaseEnteredAt: at.phaseEnteredAt, memory: state?.memory ?? {}, history: state?.history },
                now,
                timezone,
                ...evidence,
                readSetting: readBase,
            };
            return {
                bound: Object.fromEntries(
                    Object.entries(bindings).map(([key, expr]) => [key, evaluateExpression(expr, facts)]),
                ),
                validUntil: nextBindingInstant(Object.values(bindings), facts, now),
            };
        },
        generation,
        now,
    );
};

/**
 * Writes the outcome into the `@installation` record in one change under the ledger's lock, which is where the generation
 * is checked: a record that has moved on (another generation, another phase entry, a pause, a handoff) refuses it.
 */
const write = (
    pass: InstallationPass,
    scenarioName: string,
    at: Pick<ScenarioState, 'phase' | 'phaseEnteredAt'>,
    prepared: Prepared,
    generation: number,
    now: number,
): InstallationPublishStatus => {
    const outcome: { status: InstallationPublishStatus } = { status: 'failed' };
    const changed = pass.ledger.change(INSTALLATION_KEY, (current) => {
        if (current && ((current.generation ?? 0) !== generation || current.phaseEnteredAt !== at.phaseEnteredAt)) {
            return { refuse: 'stale' };
        }
        if (current?.paused || current?.handoff) return { refuse: 'held' };
        const base: ScenarioState = {
            ...(current ?? initialState(scenarioName, at.phase, at.phaseEnteredAt)),
            generation,
        };
        if (!prepared.ok) {
            const halted = blockedText(at.phase, prepared.key, prepared.reason);
            const cleared = withoutPublication(base);
            outcome.status = 'blocked';
            if (cleared.lastError?.message === halted) return cleared;
            return withNotice({ ...cleared, lastError: { at: now, message: halted } }, `Halted: ${halted}`, now);
        }
        if (prepared.publication === null) {
            outcome.status = 'cleared';
            return withoutPublication(base);
        }
        outcome.status = 'published';
        return { ...withoutPublication(base), published: prepared.publication };
    });
    if (changed.ok) {
        if (!prepared.ok) {
            log().error(`installation scenario halted: ${blockedText(at.phase, prepared.key, prepared.reason)}`, null);
        }
        return outcome.status;
    }
    // A write the record refused (a generation, a pause) is no failure of this runtime: it is no longer the owner's step.
    if (changed.reason === 'stale') return 'stale';
    if (changed.reason === 'held') return 'held';
    log().warning(`installation settings were not saved (${changed.reason})`, null);
    return 'failed';
};

export { publishInstallationOverlay };
export type { InstallationPass, InstallationPublishStatus };
