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
 * The installation stage (runInstallationStage) runs on top of it: under the same ownership and the same step lock it starts
 * the progress at the start phase, finishes an interrupted handoff, publishes, and then runs the scenario's account rules
 * (the rules whose stage is `account`) through the shared runner, publishing again after each confirmed action and phase
 * change. A scoped Run of one challenge only publishes (publishInstallationOverlay): it never runs account work.
 */

import * as settings from '../../settings';
import { errorMessage } from '../../errorMessage';
import { platform } from '../../platform/port';
import { captureInstallationTimezone } from '../installationTimezone';
import { announceEffectiveChange } from '../effectiveEvents';
import { evaluateExpression } from '../../scenarios/expressions';
import { INSTALLATION_KEY, initialState } from '../../scenarioStateStore';
import type { StateLock } from '../../scenarioStateStore';
import type { ExpressionContext } from '../../scenarios/expressions';
import type { OperationRecord } from '../../scenarios/runtime';
import type { ScenarioPublication, ScenarioState } from '../../types/stores';
import type { ScenarioStateLedger } from '../../types/votingPass';
import type { ClaimDeps } from '../autoClaim';
import type { ScenarioDocument } from '../../settings/scenarioSchema';
import { evidenceNeeded, loadAccountEvidence } from './facts';
import type { AccountReads } from './facts';
import { withNotice } from './rule';
import { advance, loadState } from './step';
import { nextBindingInstant } from './overlay';
import { log, nowSec } from './support';
import type { AccountContext } from './types';

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
    /**
     * Whether a full Stop made this cycle obsolete (the run epoch it began under is no longer current): nothing is then
     * published and no account rule runs. Absent where no Stop fence is in play.
     */
    obsolete?: () => Promise<boolean>;
};

/**
 * What the step did: `none` (no installation scenario that runs), `not-owner` (another runtime owns it), `stale` (the
 * assignment is at another generation, or the record is not this scenario's: nothing is written), `held` (paused, or a
 * handoff not finished), `busy` (another process holds the step), `unreadable` (the progress cannot be read), `blocked`
 * (the phase could not be prepared: its publication is cleared and the reason recorded), `published`, `cleared` (the
 * phase sets nothing: no publication stands), `fenced` (a full Stop came after this cycle began: nothing is published),
 * `unavailable` (the installation's effective time zone cannot be read: nothing is published or run, and the saved zone never
 * takes its place) and `failed` (a write did not land).
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
    | 'fenced'
    | 'unavailable'
    | 'failed';

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

/** A pass with the time zone captured once for the cycle: every evaluation of the cycle runs on that one value. */
type CyclePass = InstallationPass & { timezone: string };

/** The scenario the installation runs and the generation it runs under, once this runtime is known to be its owner. */
type Owned = { scenario: ScenarioDocument; generation: number };

/**
 * The installation scenario this runtime owns, or the status that says why not.
 */
const ownedScenario = (): { owned: Owned } | { status: InstallationPublishStatus } => {
    // The assignment first: an installation with none costs nothing, and the progress record is not read.
    const assignment = settings.getInstallationScenario();
    if (!assignment) return { status: 'none' };
    if (platform().capabilities.executor !== assignment.executor) return { status: 'not-owner' };
    const scenario = settings.getScenario(assignment.scenario);
    if (!scenario || scenario.scope !== 'installation') return { status: 'none' };
    const generation = settings.installationGeneration();
    // A generation the assignment has not reached (a change that was begun and not finished) is not one to publish under.
    if (generation === null) return { status: 'unreadable' };
    if (generation !== assignment.generation) return { status: 'stale' };
    return { owned: { scenario, generation } };
};

const publishUnderOwnership = async (pass: InstallationPass): Promise<InstallationPublishStatus> => {
    const own = ownedScenario();
    if ('status' in own) return own.status;
    // Captured once for this cycle, after ownership (an installation with no scenario here reads nothing).
    const timezone = captureInstallationTimezone();
    if (timezone === null) return 'unavailable';
    const lock = pass.lock ? pass.lock(INSTALLATION_KEY) : NO_LOCK;
    if (!lock.ok) return 'busy';
    try {
        return await publishLocked({ ...pass, timezone }, own.owned);
    } finally {
        lock.release();
    }
};

/**
 * The publication itself, with the installation's step lock already held by the caller.
 */
const publishLocked = async (pass: CyclePass, { scenario, generation }: Owned): Promise<InstallationPublishStatus> => {
    // Publishing needs the run epoch the cycle began under to be current: after a full Stop it is not.
    if (await pass.obsolete?.()) return 'fenced';
    const { corrupt, state } = pass.ledger.get(INSTALLATION_KEY);
    if (corrupt) return 'unreadable';
    // Paused, a handoff not finished, or withdrawn by a full Stop (until an explicit user re-arm clears it): nothing is published.
    if (state?.paused || state?.handoff || state?.withdrawn) return 'held';
    if (state && state.scenario.toLowerCase() !== scenario.name.toLowerCase()) return 'stale';
    const now = nowSec();
    const phase = state?.phase ?? scenario.start;
    const phaseEnteredAt = state?.phaseEnteredAt ?? now;
    if (!scenario.phases[phase]) return 'none';

    const at = { phase, phaseEnteredAt, published: state?.published, phasePatch: state?.phasePatch };
    const prepared = await prepare(pass, scenario, at, state, generation, now);
    return write(pass, scenario.name, at, prepared, generation, now);
};

/** What the installation stage needs of the cycle beyond the publication: the claim endpoints, and the record of what was done. */
type InstallationStagePass = InstallationPass & {
    claims: ClaimDeps;
    operations: OperationRecord;
    /** What the installation's `startAutovote` / `stopAutovote` actions ask of the autovote controller (null: none here). */
    autovote?: AccountContext['autovote'];
};

/**
 * The installation stage of one cycle, when this runtime owns the installation scenario: starts or recovers its progress,
 * publishes its overlay, and (with `rules`) runs its account rules. Never throws. Run before the mission read and the join
 * and claim pre-steps. The step lock is held for the whole stage; the storage lock is not (the ledger takes it per write).
 */
const runInstallationStage = async (
    pass: InstallationStagePass,
    { rules }: { rules: boolean },
): Promise<InstallationPublishStatus> => {
    try {
        const own = ownedScenario();
        if ('status' in own) return own.status;
        // Captured once for this cycle, after ownership: the publication, the rules and every republish run on this one value.
        const timezone = captureInstallationTimezone();
        if (timezone === null) return 'unavailable';
        const lock = pass.lock ? pass.lock(INSTALLATION_KEY) : NO_LOCK;
        if (!lock.ok) return 'busy';
        try {
            return await stageLocked({ ...pass, timezone }, own.owned, lock, rules);
        } finally {
            lock.release();
        }
    } catch (error) {
        log().error(`the installation stage failed: ${errorMessage(error) || error}`, null);
        return 'failed';
    }
};

const stageLocked = async (
    pass: InstallationStagePass & CyclePass,
    owned: Owned,
    lock: StateLock,
    rules: boolean,
): Promise<InstallationPublishStatus> => {
    const ctx: AccountContext = {
        stage: 'account',
        challengeId: INSTALLATION_KEY,
        scenario: owned.scenario,
        timezone: pass.timezone,
        ledger: pass.ledger,
        stepLock: lock,
        beforeSpend: null,
        tag: 'the installation scenario',
        reads: { subject: 'the installation', token: pass.token, ...pass.reads },
        operations: pass.operations,
        claims: { deps: pass.claims },
        autovote: pass.autovote ?? null,
        overlay: {
            // The step lock is the caller's: the publication is made again under it, from the record as it now stands.
            republish: async () => {
                await publishLocked(pass, owned);
            },
            // The settings of a record with a patch applied, prepared and not written.
            check: async (candidate) => {
                const prepared = await prepare(pass, owned.scenario, candidate, candidate, owned.generation, nowSec());
                if (prepared.ok) return null;
                return prepared.key === null ? prepared.reason : `${prepared.key}: ${prepared.reason}`;
            },
        },
    };
    // A progress record that exists gets the recovery a challenge's gets before anything is published: an interrupted
    // handoff is finished, a paused installation is held, a record of another scenario is started over at the start phase.
    // One that does not exist yet is made by the publication below, at the start phase under the generation the assignment
    // is at.
    if (pass.ledger.get(INSTALLATION_KEY).state !== null) loadState(ctx, nowSec());
    const status = await publishLocked(pass, owned);
    if (rules && (status === 'published' || status === 'cleared')) await advance(ctx, nowSec());
    return status;
};

const prepare = async (
    pass: CyclePass,
    scenario: NonNullable<ReturnType<typeof settings.getScenario>>,
    at: Pick<ScenarioState, 'phase' | 'phaseEnteredAt' | 'published' | 'phasePatch'>,
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
    const { timezone } = pass;
    return settings.prepareInstallationSnapshot(
        scenario,
        at,
        (readBase) => {
            const facts: ExpressionContext = {
                subject: { kind: 'installation' },
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
        if (current?.paused || current?.handoff || current?.withdrawn) return { refuse: 'held' };
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
        // What applies to the installation may have changed (a phase published, or none stands any more): the windows are told.
        announceEffectiveChange();
        return outcome.status;
    }
    // A write the record refused (a generation, a pause) is no failure of this runtime: it is no longer the owner's step.
    if (changed.reason === 'stale') return 'stale';
    if (changed.reason === 'held') return 'held';
    log().warning(`installation settings were not saved (${changed.reason})`, null);
    return 'failed';
};

export { publishInstallationOverlay, runInstallationStage };
export type { InstallationPass, InstallationPublishStatus, InstallationStagePass };
