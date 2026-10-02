/**
 * Types shared by the scenario runner's modules.
 */

import type { Challenge, ChallengeMember, MemberRanking, RankingEntry } from '../../types/gurushots';
import type { ScenarioState } from '../../types/stores';
import type { ScenarioStateLedger } from '../../types/votingPass';
import type { CurrencyPassDeps } from '../currencyAuto';
import type { ScenarioDocument } from '../../settings/scenarioSchema';
import type { PassContext } from '../votingOrchestrator';

type ScenarioRule = NonNullable<ScenarioDocument['phases'][string]['rules']>[number];

type ValidatedRule = ScenarioRule & { id: string };

type ScenarioAction = ScenarioRule['do'][number];

type ActionType = ScenarioAction['type'];

type SpendAction = 'swap' | 'unlockBoost' | 'fillExposure';

type SpendKind = 'swaps' | 'keys' | 'fills';

type SwapPhoto = { id: string; member_id: string };

/**
 * The pass as the runner reads it: every host that runs scenarios also passes
 * the currency endpoints.
 */
type ScenarioPass = PassContext & { currency: CurrencyPassDeps };

type RunnerContext = {
    challenge: Challenge;
    challengeId: string;
    scenario: ScenarioDocument;
    timezone: string;
    pass: ScenarioPass;
    ledger: ScenarioStateLedger;
};

/**
 * A challenge an action has just acted on: the action's own reads (the entry
 * it picked, the boost/turbo state it checked) or the spend that landed on it
 * establish the member tree the local reflect-writes touch.
 */
type ActedChallenge = Challenge & {
    member: ChallengeMember & { ranking: MemberRanking & { entries: RankingEntry[] } };
};

/**
 * What an action did: its effects on the scenario state when done, or why not.
 */
type ActionEffects = {
    remember?: Record<string, string>;
    forget?: string;
    spent?: SpendKind;
    goto?: string;
    notice?: string;
};

type DoneOutcome = { status: 'done' } & ActionEffects;

type NotDoneOutcome = { status: 'skipped' | 'failed' | 'deferred'; message: string };

type ActionOutcome = DoneOutcome | NotDoneOutcome;

type ActionHandler<A extends ScenarioAction> = (
    action: A,
    ctx: RunnerContext,
    state: ScenarioState,
) => Promise<ActionOutcome>;

export type {
    ScenarioRule,
    ValidatedRule,
    ScenarioAction,
    ActionType,
    SpendAction,
    SpendKind,
    SwapPhoto,
    ScenarioPass,
    RunnerContext,
    ActedChallenge,
    ActionEffects,
    DoneOutcome,
    NotDoneOutcome,
    ActionHandler,
};
