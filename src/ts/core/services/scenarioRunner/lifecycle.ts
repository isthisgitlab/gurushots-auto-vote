/**
 * The lifecycle coordinator: one place that routes a cycle's scenario work through the stages of a subject's life, over
 * the one runner and the existing producers. Both strategies (strategies/real, mock/strategy.ts) call it once per cycle:
 *
 *   1. installation: the installation scenario's progress, overlay and `account` rules (only the owner runtime, only at the
 *      generation it was assigned under) — before the mission read and the join and claim pre-steps;
 *   2. the mission read and the pre-steps, and in the join pass:
 *   3. preJoin: for a candidate whose scenario has `preJoin` rules, those rules run before the Auto Join switch and the
 *      timing gates are asked, even with Auto Join off; its `join` action goes through the join pass's own decision;
 *   4. active: the voting pass, as before (services/scenarioRunner/step.ts);
 *   5. postClose: for each confirmed completed challenge whose scenario has `postClose` rules and whose progress exists, those
 *      rules run; a challenge that merely left the active list is not closed.
 *
 * A scoped Run of one challenge runs the active stage of that challenge only: the coordinator is asked for no account, preJoin
 * or postClose work then (the installation's overlay is still published, as before).
 *
 * Every stage runs one subject at a time under that subject's step lock, with the subject's one progress record: the record a
 * candidate has before the join is the one it has after it.
 */

import * as logger from '../../logger';
import * as settings from '../../settings';
import { errorMessage } from '../../errorMessage';
import { captureInstallationTimezone } from '../installationTimezone';
import * as cancellation from '../../voting/cancellation';
import { DEFAULT_STAGES } from '../../scenarios/vocabulary';
import { admitsAtCountOne } from '../../scenarios/evaluate';
import { createOperationRecord } from '../../scenarios/runtime';
import type { OperationRecord } from '../../scenarios/runtime';
import type { Challenge, CompletedChallenge } from '../../types/gurushots';
import type { ScenarioStage } from '../../types/scenario';
import type { ScenarioDocument } from '../../settings/scenarioSchema';
import type { RuleMatchChallenge } from '../../types/settings';
import type { StateLock } from '../../scenarioStateStore';
import { currentAutovoteControl } from '../../autovote/control';
import { isClaimable, readCompletedChallenges } from '../autoClaim';
import type { ClaimDeps } from '../autoClaim';
import { publishInstallationOverlay, runInstallationStage } from './installation';
import type { InstallationPass, InstallationPublishStatus } from './installation';
import { advance, NO_LOCK, noteSkipped } from './step';
import { log, nowSec } from './support';
import type { JoinAttempt, PostCloseContext, PreJoinContext, ScenarioJoin } from './types';

/**
 * What the coordinator needs of a cycle: the token, the ledger (the persisted one, or the mock run's in-memory one), the
 * cross-process step lock (absent where one process runs the steps: mock mode), the read-only account endpoints, and the
 * claim endpoints.
 */
type LifecycleDeps = InstallationPass & {
    claims: ClaimDeps;
    /** False while another loop (the Android background service) owns scenarios: this one runs no candidate or completed work. */
    enabled?: () => boolean;
};

/**
 * What the join pass is given to let a candidate's scenario decide before the gates: the cycle's operation record, whether any
 * scenario has pre-join rules at all (the pass is then needed even with Auto Join off), and the step to run per candidate.
 */
type PreJoinHook = {
    operations: OperationRecord;
    armed: () => boolean;
    /** Runs the candidate's pre-join rules. Resolves the join the rules made (through `join`), or null when none was. */
    run: (candidate: Challenge, join: ScenarioJoin) => Promise<JoinAttempt | null>;
};

type Lifecycle = {
    /** What a scenario action or the normal automation already did this cycle, shared by the pre-steps and the pass. */
    operations: OperationRecord;
    installation: (options: { rules: boolean }) => Promise<InstallationPublishStatus>;
    preJoin: PreJoinHook;
    postClose: () => Promise<void>;
};

/**
 * Whether any rule of the document runs in the stage. A phase's count-1 `absolute` submit row is a pre-join rule too: it
 * joins the candidate once it is due.
 */
const hasStage = (doc: ScenarioDocument, stage: ScenarioStage): boolean => {
    const defaults: readonly ScenarioStage[] = DEFAULT_STAGES[doc.scope ?? 'challenge'];
    return Object.values(doc.phases).some(
        (phase) =>
            (stage === 'preJoin' && admitsAtCountOne(phase)) ||
            (phase.rules ?? []).some((rule) => (rule.stages ?? defaults).includes(stage)),
    );
};

/**
 * Whether any stored scenario has a rule in the stage: with none, the stage costs nothing (no list is read for it).
 */
const stageInUse = (stage: ScenarioStage): boolean =>
    Object.values(settings.getScenarios?.() ?? {}).some((doc) => hasStage(doc, stage));

/**
 * The scenario assigned to a challenge that is not (or no longer) in the active list: its own assignment, else the one a
 * title rule gives it. (The active list's challenges are resolved through the settings cache the pass fills.)
 */
const assignedScenario = (id: string | number, target: RuleMatchChallenge | string): string => {
    const own: unknown = settings.getChallengeOverride('scenario', id);
    if (typeof own === 'string' && own !== '') return own;
    const rule = settings.resolveRuleSetting('scenario', target);
    return typeof rule?.value === 'string' ? rule.value : '';
};

/**
 * The challenge scenario assigned to a subject, when it has a rule in the stage.
 */
const scenarioFor = (
    id: string | number,
    target: RuleMatchChallenge | string,
    stage: ScenarioStage,
): ScenarioDocument | null => {
    const name = assignedScenario(id, target);
    const doc = name === '' ? null : settings.getScenario(name);
    return doc && (doc.scope ?? 'challenge') === 'challenge' && hasStage(doc, stage) ? doc : null;
};

/**
 * Runs a candidate's pre-join rules under the candidate's step lock. Never throws.
 */
const runPreJoinStep = async (
    deps: LifecycleDeps,
    operations: OperationRecord,
    candidate: Challenge,
    join: ScenarioJoin,
): Promise<JoinAttempt | null> => {
    if (deps.enabled?.() === false) return null;
    const scenario = scenarioFor(candidate.id, candidate, 'preJoin');
    if (!scenario) return null;
    const challengeId = String(candidate.id);
    const lock: StateLock = deps.lock ? deps.lock(challengeId) : NO_LOCK;
    if (!lock.ok) {
        noteSkipped(candidate, lock.unavailable === true);
        return null;
    }
    const tag = logger.challengeTag(candidate);
    // The zone, captured once for this step; one that cannot be read runs nothing (the saved zone never takes its place).
    const timezone = captureInstallationTimezone();
    if (timezone === null) {
        lock.release();
        log().warning(`${tag} the time zone is unavailable — the pre-join rules wait`, null);
        return null;
    }
    const made: { attempt: JoinAttempt | null } = { attempt: null };
    const ctx: PreJoinContext = {
        stage: 'preJoin',
        challenge: candidate,
        challengeId,
        scenario,
        timezone,
        ledger: deps.ledger,
        stepLock: lock,
        beforeSpend: null,
        tag,
        reads: { subject: tag, token: deps.token, ...deps.reads },
        operations,
        join: async (maxCoins, policy) => {
            made.attempt = await join(maxCoins, policy);
            // Whatever asked for it, this candidate has had its join this pass (the schedule's own is not asked again).
            operations.mark('join', challengeId);
            return made.attempt;
        },
    };
    try {
        await advance(ctx, nowSec());
    } catch (error) {
        log().error(`${tag} scenario step failed: ${errorMessage(error) || error}`, null);
    } finally {
        lock.release();
    }
    return made.attempt;
};

/**
 * Runs one completed challenge's post-close rules, and says whether the challenge has no post-close work left (its rewards
 * are not waiting, and none of its progress is unresolved): the lowercase name of the scenario it is settled under, or null.
 * A challenge whose progress cannot be read is never settled.
 */
const runPostCloseStep = async (
    deps: LifecycleDeps,
    operations: OperationRecord,
    completed: CompletedChallenge,
): Promise<string | null> => {
    const scenario = scenarioFor(completed.id, String(completed.title ?? ''), 'postClose');
    // No post-close scenario: nothing to keep. (The empty name matches no assignment, so a later one is not read as settled.)
    if (!scenario) return '';
    const challengeId = String(completed.id);
    const before = deps.ledger.get(challengeId);
    if (before.corrupt) return null;
    // Only a challenge that has progress (it ran under this scenario while it was joined) has post-close work.
    if (!before.state) return scenario.name.toLowerCase();
    const lock: StateLock = deps.lock ? deps.lock(challengeId) : NO_LOCK;
    const tag = logger.challengeTag(completed);
    if (!lock.ok) {
        log().debug(`${tag} another process is running its scenario — skipped this pass`, null);
        return null;
    }
    // The zone, captured once for this step; one that cannot be read runs nothing (the saved zone never takes its place).
    const timezone = captureInstallationTimezone();
    if (timezone === null) {
        lock.release();
        log().warning(`${tag} the time zone is unavailable — the post-close rules wait`, null);
        return null;
    }
    const ctx: PostCloseContext = {
        stage: 'postClose',
        completed,
        challengeId,
        scenario,
        timezone,
        ledger: deps.ledger,
        stepLock: lock,
        beforeSpend: null,
        tag,
        reads: { subject: tag, token: deps.token, ...deps.reads },
        operations,
        claims: { deps: deps.claims },
    };
    try {
        await advance(ctx, nowSec());
    } catch (error) {
        log().error(`${tag} scenario step failed: ${errorMessage(error) || error}`, null);
    } finally {
        lock.release();
    }
    const after = deps.ledger.get(challengeId);
    const settled =
        !after.corrupt && !isClaimable(completed) && !(after.state && settings.unresolvedScenarioWork(after.state));
    return settled ? scenario.name.toLowerCase() : null;
};

/**
 * The post-close stage: the completed challenges are listed through the existing read, and a listing that failed (or was
 * cut short by an error) is read as no evidence: nothing runs this cycle. Never throws.
 */
const runPostClose = async (deps: LifecycleDeps, operations: OperationRecord): Promise<void> => {
    // What an earlier pass found is not current for this one: it is forgotten first, and remembered again only by a pass that
    // read the listing and ran every challenge in it (cancelled, failed, disabled and unused all leave nothing).
    settings.rememberPostCloseListing?.(null);
    if (deps.enabled?.() === false) return;
    try {
        if (!stageInUse('postClose')) return;
        const listing = await readCompletedChallenges(deps.token, deps.claims);
        if (listing.failedPage !== null) {
            log().warning(
                `completed challenges could not be read (page ${listing.failedPage}) — no post-close work this cycle`,
                null,
            );
            return;
        }
        const listed: string[] = [];
        const settled: Array<[string, string]> = [];
        for (const completed of listing.challenges) {
            if (cancellation.isCancelled()) return;
            // A listing row without an identity names nothing to run a scenario for.
            if (completed?.id === undefined || completed.id === null) continue;
            const name = await runPostCloseStep(deps, operations, completed);
            listed.push(String(completed.id));
            if (name !== null) settled.push([String(completed.id), name]);
        }
        // (A listing cut short by the page cap does not show the oldest closed challenges: those are "not in the listing", and
        // the retention bound applies to them.)
        settings.rememberPostCloseListing({ listed, settled });
    } catch (error) {
        log().error(`the post-close stage failed: ${errorMessage(error) || error}`, null);
    }
};

/**
 * The coordinator of one cycle. `operations` is the cycle's record of what was done, shared with the join pass, the claim
 * pass and the voting pass.
 */
const createLifecycle = (deps: LifecycleDeps, operations: OperationRecord = createOperationRecord()): Lifecycle => {
    // The installation's requests for the voting stages are bound to the Stop capture of the moment this cycle began: a Stop
    // that lands while it runs makes them obsolete, and a user Run after it does not make them current again.
    const control = currentAutovoteControl();
    const captured = control?.capture();
    const autovote = control && captured ? (on: boolean) => control.request(on, captured) : null;
    const obsolete = control && captured ? async () => !(await control.admits(captured)) : undefined;
    return {
        operations,
        installation: ({ rules }) =>
            rules
                ? runInstallationStage({ ...deps, operations, autovote, obsolete }, { rules })
                : publishInstallationOverlay({ ...deps, obsolete }),
        preJoin: {
            operations,
            armed: () => deps.enabled?.() !== false && stageInUse('preJoin'),
            run: (candidate, join) => runPreJoinStep(deps, operations, candidate, join),
        },
        postClose: () => runPostClose(deps, operations),
    };
};

/**
 * The cycle of an armed controller (cycle mode `armed`): the installation stage and nothing else. It covers no challenge, so a
 * scoped one is refused. The stage's account rules may claim a mission reward or ask the controller for the voting stages; the
 * pre-steps, the voting pass, the pre-join and post-close stages never run.
 */
const runArmedCycle = async (
    lifecycle: Lifecycle,
    challengeIdFilter: string | number | null,
): Promise<{ success: boolean; message?: string; error?: string }> => {
    if (challengeIdFilter !== null)
        return { success: false, error: 'An installation cycle covers no single challenge' };
    await lifecycle.installation({ rules: true });
    return { success: true, message: 'Installation cycle completed' };
};

export { createLifecycle, hasStage, runArmedCycle };
export type { Lifecycle, LifecycleDeps, PreJoinHook };
