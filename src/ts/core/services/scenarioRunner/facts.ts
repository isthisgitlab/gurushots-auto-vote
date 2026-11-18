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

import * as logger from '../../logger';
import * as settings from '../../settings';
import { errorMessage } from '../../errorMessage';
import { exprReferences } from '../../scenarios/expressions';
import { FACTS } from '../../scenarios/facts';
import { entriesOf } from '../../scenarios/selectors';
import { scanFillCandidates } from '../autoFill';
import { isClaimable, readCompletedChallenges } from '../autoClaim';
import { missionEvidence } from '../missions';
import { log, nowSec } from './support';

import { baselineTransportPolicy } from '../../api/transportPolicy';
import type { TransportPolicy } from '../../api/transportPolicy';
import type { FactEvidence, Evidence } from '../../scenarios/facts';
import type { Bankroll, CompletedChallenge, Mission } from '../../types/gurushots';
import type { ScenarioCondition } from '../../types/scenario';
import type { ScenarioDocument } from '../../settings/scenarioSchema';
import type { RunnerContext } from './types';

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
    'photo-scan': 'photoScan',
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
        for (const { name } of exprReferences(expression).facts) {
            for (const dependency of FACTS[name].dependencies) {
                const kind = EVIDENCE_OF_DEPENDENCY[dependency];
                if (kind) into.add(kind);
            }
        }
    }
};

/**
 * The evidence the rules and the bindings of a scenario read. Given `phase`, only those of that phase (the engine
 * evaluates one phase at a time); without it, every phase. `rules: false` leaves the rules out: the installation's
 * publication is worked out from its bindings alone.
 */
const evidenceNeeded = (scenario: ScenarioDocument, phase?: string, rules = true): Set<EvidenceKind> => {
    const needed = new Set<EvidenceKind>();
    const phases = phase === undefined ? Object.values(scenario.phases) : [scenario.phases[phase]];
    for (const item of phases) {
        if (rules) for (const rule of item?.rules ?? []) collectEvidence(rule.if, needed);
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
 * The account evidence (balance, missions, completed challenges) among the `needed` kinds, fetched under the saved
 * transport policy. Nothing is fetched for a kind that is not needed.
 */
const loadAccountEvidence = async (
    needed: ReadonlySet<EvidenceKind>,
    reads: AccountReads,
): Promise<Pick<FactEvidence, 'bankroll' | 'missions' | 'rewards'>> => {
    const policy = baselineTransportPolicy();
    const evidence: Pick<FactEvidence, 'bankroll' | 'missions' | 'rewards'> = {};
    if (needed.has('bankroll')) evidence.bankroll = await readBankroll(reads, policy);
    if (needed.has('missions')) evidence.missions = await readMissions(reads, policy);
    if (needed.has('rewards')) evidence.rewards = await readRewards(reads, policy);
    return evidence;
};

/**
 * The entry-age ledger's evidence for the subject challenge: when each entry went in, and which entries the app marked
 * as a doubtful subject match. A ledger that cannot be read, or refreshed, is unreadable for both.
 */
const readLedger = async (
    ctx: RunnerContext,
    needed: ReadonlySet<EvidenceKind>,
): Promise<Pick<FactEvidence, 'entryAges' | 'uncertain'>> => {
    const { entryAges: ledger } = ctx.pass;
    const out: Pick<FactEvidence, 'entryAges' | 'uncertain'> = {};
    const failed = (reason: string) => {
        if (needed.has('entryAges')) out.entryAges = unreadable(reason);
        if (needed.has('uncertain')) out.uncertain = unreadable(reason);
        return out;
    };
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
        return out;
    } catch (error) {
        log().warning(
            `${logger.challengeTag(ctx.challenge)} could not read the entry ages for the scenario: ${errorMessage(error) || error}`,
            null,
        );
        return failed('entry-ages-unreadable');
    }
};

const readPins = (ctx: RunnerContext): Promise<NonNullable<FactEvidence['pins']>> =>
    guarded(logger.challengeTag(ctx.challenge), 'the pinned photos', 'pins-unreadable', async () => {
        const { boost, turbo } = settings.getEntryPins(ctx.challengeId);
        return { readable: true, boost, turbo };
    });

/**
 * The photo scan, with the tag settings the scheduled fill reads (settings resolved for this challenge): read-only, and
 * the same preparation a submission runs. It is the dearest read, so only a rule that reads a photo fact asks for it.
 */
const readPhotoScan = (ctx: RunnerContext): Promise<NonNullable<FactEvidence['photoScan']>> =>
    guarded(logger.challengeTag(ctx.challenge), 'the photo candidates', 'photo-scan-failed', async () => {
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
 * The account endpoints of a challenge's pass, as the account evidence reads them. Late-bound to the pass's endpoints, so a
 * replaced endpoint is the one that is called.
 */
const accountReadsOf = ({ pass, challenge }: RunnerContext): AccountReads => {
    const { getMyMissions, getMyCompletedChallenges } = pass.api;
    return {
        subject: logger.challengeTag(challenge),
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
): Promise<FactEvidence> => {
    const needed = new Set(
        [...evidenceNeeded(scenario, phase)].filter(
            (kind) => stage === 'all' || (stage === 'policy') === POLICY_EVIDENCE.has(kind),
        ),
    );
    const evidence: FactEvidence = await loadAccountEvidence(needed, accountReadsOf(ctx));
    if (needed.has('entryAges') || needed.has('uncertain')) Object.assign(evidence, await readLedger(ctx, needed));
    if (needed.has('pins')) evidence.pins = await readPins(ctx);
    if (needed.has('photoScan')) evidence.photoScan = await readPhotoScan(ctx);
    return evidence;
};

export { evidenceNeeded, loadAccountEvidence, loadScenarioSnapshot };
export type { AccountReads, EvidenceKind, EvidenceStage };
