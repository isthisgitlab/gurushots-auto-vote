/**
 * The scenario evidence loader: fetches, once per evaluation, only the evidence the rules of a scenario read through
 * their conditions and expressions, and hands it to the engine as the evidence fields of a fact snapshot
 * (scenarios/facts.ts). The pure registry decides what each fact means; this module does the reading.
 *
 * Every read goes through the pass's endpoints (the API factory's real or mock surface, projected into the pass) or an
 * existing service, with the pass token, and is read-only: no join, claim,
 * vote, submit or spend is made to learn a fact. A read that fails (a thrown error, or no list in the answer) is
 * recorded as unreadable evidence with its reason, never as an empty value, so its facts answer unknown.
 *
 * The account reads (the balance, the missions, the completed challenges) run under the saved transport policy, handed
 * to each as typed data (baselineTransportPolicy, which the API factory exports too): they are what a binding, or the owner's publication, is
 * worked out from, so they cannot wait for the effective policy those may overlay. Only these read-only calls take it.
 * They serve a challenge's scenario and the installation's (loadAccountEvidence).
 */

import * as settings from '../../settings';
import { errorMessage } from '../../errorMessage';
import { exprReferences } from '../../scenarios/expressions';
import { runsIn } from '../../scenarios/evaluate';
import { FACTS } from '../../scenarios/facts';
import { entriesOf } from '../../scenarios/selectors';
import { scanFillCandidates } from '../autoFill';
import { isClaimable, readCompletedChallenges } from '../autoClaim';
import { missionEvidence } from '../missions';
import { pendingBoostTarget } from '../votingOrchestrator/boost';
import { platform } from '../../platform/port';
import { log, nowSec } from './support';

import { baselineTransportPolicy } from '../../api/transportPolicy';
import type { TransportPolicy } from '../../api/transportPolicy';
import type { FactEvidence, Evidence, HostEvidence } from '../../scenarios/facts';
import type { Bankroll, CompletedChallenge, Mission } from '../../types/gurushots';
import type { ScenarioCondition, ScenarioExpr, ScenarioSelector, ScenarioStage } from '../../types/scenario';
import type { ScenarioDocument } from '../../settings/scenarioSchema';
import type { ActiveContext, RunnerContext, ScenarioPass } from './types';

/** The evidence a fact can need beyond the current challenge and clock. */
type EvidenceKind = keyof FactEvidence;

/**
 * The evidence each fact dependency of the registry names (scenarios/facts.ts lists them in `dependencies`), so the
 * registry stays the one place that says which fact needs what.
 */
const EVIDENCE_OF_DEPENDENCY: Readonly<Record<string, EvidenceKind>> = {
    bankroll: 'bankroll',
    missions: 'missions',
    rewards: 'rewards',
    'entry-ages': 'entryAges',
    'entry-uncertain': 'uncertain',
    'entry-pins': 'pins',
    'entry-pending-boost': 'pendingBoost',
    'photo-scan': 'photoScan',
    host: 'host',
};

/**
 * The evidence a selector reads: the pinned photos, the entry times (also to order matching entries by age), the photo a
 * fill-new boost waits on.
 */
const collectSelectorEvidence = (selector: ScenarioSelector, into: Set<EvidenceKind>): void => {
    switch (selector.by) {
        case 'pinned':
            into.add('pins');
            break;
        case 'pendingBoostTarget':
            into.add('pendingBoost');
            break;
        case 'newest':
        case 'oldest':
            into.add('entryAges');
            break;
        case 'matching':
            if (selector.order === 'age') into.add('entryAges');
            break;
        default:
            break;
    }
};

/**
 * The evidence the conditions of a rule read: a `balance` condition reads the bankroll, an expression reads the evidence
 * of every fact in it, and the composing conditions are walked through.
 */
const collectEvidence = (conditions: readonly ScenarioCondition[] | undefined, into: Set<EvidenceKind>): void => {
    for (const condition of conditions ?? []) {
        switch (condition.type) {
            case 'balance':
                into.add('bankroll');
                break;
            case 'entry':
                collectSelectorEvidence(condition.select, into);
                break;
            case 'compare':
                collectExpressionEvidence([condition.left, condition.right], into);
                break;
            case 'present':
            case 'absent':
                collectExpressionEvidence([condition.value], into);
                break;
            case 'contains':
            case 'containsAny':
            case 'containsAll':
                collectExpressionEvidence([condition.list, condition.value], into);
                break;
            case 'all':
            case 'any':
                collectEvidence(condition.of, into);
                break;
            case 'not':
                collectEvidence([condition.condition], into);
                break;
            default:
                break;
        }
    }
};

const collectExpressionEvidence = (
    expressions: Parameters<typeof exprReferences>[0][],
    into: Set<EvidenceKind>,
): void => {
    for (const expression of expressions) {
        for (const { name, select } of exprReferences(expression).facts) {
            for (const dependency of FACTS[name].dependencies) {
                const kind = EVIDENCE_OF_DEPENDENCY[dependency];
                if (kind) into.add(kind);
            }
            if (select) collectSelectorEvidence(select, into);
        }
    }
};

/**
 * The evidence one expression reads (an action's parameter, worked out when the action runs).
 */
const expressionEvidence = (expr: ScenarioExpr): Set<EvidenceKind> => {
    const needed = new Set<EvidenceKind>();
    collectExpressionEvidence([expr], needed);
    return needed;
};

/**
 * The evidence the rules and the bindings of a scenario read. Given `phase`, only those of that phase (the engine
 * evaluates one phase at a time); without it, every phase. `rules: false` leaves the rules out: the installation's
 * publication is worked out from its bindings alone. Given `stage`, only the rules that run in that stage count.
 */
const evidenceNeeded = (
    scenario: ScenarioDocument,
    phase?: string,
    rules = true,
    stage?: ScenarioStage,
): Set<EvidenceKind> => {
    const needed = new Set<EvidenceKind>();
    const phases = phase === undefined ? Object.values(scenario.phases) : [scenario.phases[phase]];
    for (const item of phases) {
        if (rules) {
            for (const rule of item?.rules ?? []) {
                // A rule of another stage is not evaluated in this one: its evidence is not fetched for it.
                if (stage === undefined || runsIn(rule, scenario, stage)) collectEvidence(rule.if, needed);
            }
        }
        collectExpressionEvidence(Object.values(item?.bindings ?? {}), needed);
    }
    return needed;
};

/**
 * The evidence that derives from the effective settings (the photo scan reads tag settings): it can be loaded only once
 * the phase's overlay is prepared. Every other kind is raw, and what a binding may read.
 */
const POLICY_EVIDENCE: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['photoScan']);

/** Which evidence a load fetches: the raw kinds, the policy kinds, or both. */
type EvidenceStage = 'raw' | 'policy' | 'all';

const unreadable = (reason: string): { readable: false; reason: string } => ({ readable: false, reason });

/**
 * The read-only account endpoints a scenario's account evidence comes from. Each takes the saved transport policy as data,
 * and an endpoint a host does not have is left out (its evidence is then unreadable, with that reason).
 */
type AccountReads = {
    /** How a failed read names its subject in the log: a challenge's tag, or the installation. */
    subject: string;
    token: string;
    getBankroll: (token: string, policy: TransportPolicy) => Promise<Bankroll | null>;
    getMyMissions?: (token: string, policy: TransportPolicy) => Promise<Mission[] | null>;
    getMyCompletedChallenges?: (
        token: string,
        start?: number,
        limit?: number,
        policy?: TransportPolicy,
    ) => Promise<CompletedChallenge[] | null>;
};

/**
 * Runs one read; a throw is logged and becomes unreadable evidence with `reason`.
 */
const guarded = async <T>(
    subject: string,
    what: string,
    reason: string,
    read: () => Promise<Evidence<T>>,
): Promise<Evidence<T>> => {
    try {
        return await read();
    } catch (error) {
        log().warning(`${subject} could not read ${what} for the scenario: ${errorMessage(error) || error}`, null);
        return unreadable(reason);
    }
};

const readBankroll = async (reads: AccountReads, policy: TransportPolicy): Promise<FactEvidence['bankroll']> => {
    try {
        return await reads.getBankroll(reads.token, policy);
    } catch (error) {
        log().warning(
            `${reads.subject} could not read the balance for the scenario: ${errorMessage(error) || error}`,
            null,
        );
        return null;
    }
};

const readMissions = (reads: AccountReads, policy: TransportPolicy): Promise<NonNullable<FactEvidence['missions']>> =>
    guarded(reads.subject, 'the missions', 'missions-unreadable', async () => {
        const { getMyMissions } = reads;
        if (!getMyMissions) return unreadable('missions-unavailable');
        const list = await getMyMissions(reads.token, policy);
        return Array.isArray(list)
            ? { readable: true, ...missionEvidence(list, nowSec()) }
            : unreadable('missions-unreadable');
    });

const readRewards = (reads: AccountReads, policy: TransportPolicy): Promise<NonNullable<FactEvidence['rewards']>> =>
    guarded(reads.subject, 'the completed challenges', 'rewards-unreadable', async () => {
        const { getMyCompletedChallenges } = reads;
        if (!getMyCompletedChallenges) return unreadable('rewards-unavailable');
        const { challenges, complete, failedPage } = await readCompletedChallenges(reads.token, {
            getMyCompletedChallenges: (token, start, limit) => getMyCompletedChallenges(token, start, limit, policy),
        });
        if (failedPage !== null) return unreadable('rewards-unreadable');
        return {
            readable: true,
            listed: challenges.map((challenge) => String(challenge?.id)),
            claimable: challenges.filter(isClaimable).map((challenge) => String(challenge.id)),
            complete,
        };
    });

/**
 * What the host knows of the remote-access pairing, through the platform port: only a sanitized status (no key, link or peer).
 * A shell with no pairing answers `supported: false`, which is not a failed read.
 */
const readHost = (reads: AccountReads): Promise<NonNullable<FactEvidence['host']>> =>
    guarded<HostEvidence>(reads.subject, 'the remote-access status', 'remote-status-unreadable', async () => {
        const status = await platform().native.readScenarioHostStatus();
        return status.supported
            ? {
                  readable: true,
                  supported: true,
                  remoteEnabled: status.remoteEnabled,
                  remoteConnected: status.remoteConnected,
              }
            : { readable: true, supported: false };
    });

/**
 * The account evidence (balance, missions, completed challenges, the host's remote status) among the `needed` kinds, fetched under the saved
 * transport policy. Nothing is fetched for a kind that is not needed.
 */
const loadAccountEvidence = async (
    needed: ReadonlySet<EvidenceKind>,
    reads: AccountReads,
): Promise<Pick<FactEvidence, 'bankroll' | 'missions' | 'rewards' | 'host'>> => {
    const policy = baselineTransportPolicy();
    const evidence: Pick<FactEvidence, 'bankroll' | 'missions' | 'rewards' | 'host'> = {};
    if (needed.has('bankroll')) evidence.bankroll = await readBankroll(reads, policy);
    if (needed.has('missions')) evidence.missions = await readMissions(reads, policy);
    if (needed.has('rewards')) evidence.rewards = await readRewards(reads, policy);
    if (needed.has('host')) evidence.host = await readHost(reads);
    return evidence;
};

/**
 * The entry-age ledger's evidence for the subject challenge: when each entry went in, which entries the app marked as a
 * doubtful subject match, and the photo a fill-new boost is waiting on. A ledger that cannot be read, or refreshed, is
 * unreadable for all of them.
 */
const readLedger = async (
    ctx: RunnerContext,
    needed: ReadonlySet<EvidenceKind>,
): Promise<Pick<FactEvidence, 'entryAges' | 'uncertain' | 'pendingBoost'>> => {
    const out: Pick<FactEvidence, 'entryAges' | 'uncertain' | 'pendingBoost'> = {};
    const failed = (reason: string) => {
        if (needed.has('entryAges')) out.entryAges = unreadable(reason);
        if (needed.has('uncertain')) out.uncertain = unreadable(reason);
        if (needed.has('pendingBoost')) out.pendingBoost = unreadable(reason);
        return out;
    };
    // Only a joined challenge in the voting pass has an entry-age ledger at hand.
    if (ctx.stage !== 'active') return failed('entry-ages-unavailable');
    const { entryAges: ledger } = ctx.pass;
    if (!ledger) return failed('entry-ages-unavailable');
    try {
        await ledger.refresh();
        const times = ledger.entryTimes(ctx.challenge);
        const uncertain = entriesOf(ctx.challenge)
            .map((entry) => String(entry.id))
            .filter((id) => ledger.isUncertain(ctx.challengeId, id));
        const { read, refresh } = ledger.health();
        if (!read || !refresh) return failed('entry-ages-unreadable');
        if (needed.has('entryAges')) out.entryAges = { readable: true, times };
        if (needed.has('uncertain')) out.uncertain = { readable: true, ids: uncertain };
        if (needed.has('pendingBoost')) {
            // The existing producer of the photo a fill-new boost is waiting on (the boost runner asks it the same way).
            out.pendingBoost = {
                readable: true,
                id: pendingBoostTarget({ challenge: ctx.challenge, entryAges: ledger })?.imageId ?? null,
            };
        }
        return out;
    } catch (error) {
        log().warning(
            `${ctx.tag} could not read the entry ages for the scenario: ${errorMessage(error) || error}`,
            null,
        );
        return failed('entry-ages-unreadable');
    }
};

const readPins = (ctx: RunnerContext): Promise<NonNullable<FactEvidence['pins']>> =>
    guarded(ctx.tag, 'the pinned photos', 'pins-unreadable', async () => {
        const { boost, turbo } = settings.getEntryPins(ctx.challengeId);
        return { readable: true, boost, turbo };
    });

/**
 * The photo scan, with the tag settings the scheduled fill reads (settings resolved for this challenge): read-only, and
 * the same preparation a submission runs. It is the dearest read, so only a rule that reads a photo fact asks for it.
 */
const readPhotoScan = (ctx: ActiveContext): Promise<NonNullable<FactEvidence['photoScan']>> =>
    guarded(ctx.tag, 'the photo candidates', 'photo-scan-failed', async () => {
        const { challenge } = ctx;
        const scan = await scanFillCandidates({
            challenge,
            token: ctx.pass.token,
            deps: ctx.pass.fillDeps,
            mustIncludeTags: settings.getEffectiveTagSetting('mustIncludeTags', challenge),
            shouldIncludeTags: settings.getEffectiveTagSetting('shouldIncludeTags', challenge),
            submitWithoutTagMatch: settings.getEffectiveSetting('submitWithoutTagMatch', ctx.challengeId),
        });
        return { readable: true, ...scan };
    });

/**
 * The account endpoints of a pass, as the account evidence reads them. Late-bound to the pass's endpoints, so a replaced
 * endpoint is the one that is called.
 *
 * @param subject - how a failed read names its subject in the log
 */
const passReads = (pass: ScenarioPass, subject: string): AccountReads => {
    const { getMyMissions, getMyCompletedChallenges } = pass.api;
    return {
        subject,
        token: pass.token,
        getBankroll: (token, policy) => pass.currency.strategy.getBankroll(token, policy),
        ...(getMyMissions ? { getMyMissions: (token, policy) => getMyMissions(token, policy) } : {}),
        ...(getMyCompletedChallenges
            ? {
                  getMyCompletedChallenges: (token, start, limit, policy) =>
                      getMyCompletedChallenges(token, start, limit, policy),
              }
            : {}),
    };
};

/**
 * The evidence the scenario's rules and bindings read, fetched for this evaluation: nothing is fetched for a fact nothing
 * reads, and every field that is returned was asked for. A read that failed is unreadable evidence, which its facts read
 * as unknown.
 *
 * @param phase - the phase being evaluated; its rules and bindings alone decide what is fetched (all phases when omitted)
 * @param stage - `raw` (what a binding may read), then `policy` once the overlay is prepared (the photo scan reads the
 *   effective tag settings); `all` fetches both in one go, for a phase that has no overlay to prepare
 */
const loadScenarioSnapshot = async (
    scenario: ScenarioDocument,
    ctx: RunnerContext,
    phase?: string,
    stage: EvidenceStage = 'all',
): Promise<FactEvidence> =>
    loadEvidence(
        new Set(
            [...evidenceNeeded(scenario, phase, true, ctx.stage)].filter(
                (kind) => stage === 'all' || (stage === 'policy') === POLICY_EVIDENCE.has(kind),
            ),
        ),
        ctx,
    );

/**
 * The evidence of the `needed` kinds for the subject, fetched now: the account evidence, the entry-age ledger's, the pinned
 * photos, and the photo scan (a joined challenge only).
 */
const loadEvidence = async (needed: ReadonlySet<EvidenceKind>, ctx: RunnerContext): Promise<FactEvidence> => {
    const evidence: FactEvidence = await loadAccountEvidence(needed, ctx.reads);
    if (needed.has('entryAges') || needed.has('uncertain') || needed.has('pendingBoost')) {
        Object.assign(evidence, await readLedger(ctx, needed));
    }
    if (needed.has('pins')) evidence.pins = await readPins(ctx);
    if (needed.has('photoScan')) {
        // The scan runs on a joined challenge, with the pass's fill endpoints; a candidate's photos are not scanned here.
        evidence.photoScan = ctx.stage === 'active' ? await readPhotoScan(ctx) : unreadable('photo-scan-unavailable');
    }
    return evidence;
};

/**
 * The evidence the selector of an action reads, fetched when the action runs.
 */
const loadSelectorEvidence = (selector: ScenarioSelector, ctx: RunnerContext): Promise<FactEvidence> => {
    const needed = new Set<EvidenceKind>();
    collectSelectorEvidence(selector, needed);
    return loadEvidence(needed, ctx);
};

export {
    evidenceNeeded,
    expressionEvidence,
    loadAccountEvidence,
    loadEvidence,
    loadScenarioSnapshot,
    loadSelectorEvidence,
    passReads,
};
export type { AccountReads, EvidenceKind, EvidenceStage };
