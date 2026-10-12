/**
 * Types shared by the scenario runner's modules.
 */

import type { Challenge, ChallengeMember, MemberRanking, RankingEntry } from '../../types/gurushots';
import type { ScenarioState, SpendAction } from '../../types/stores';
import type { ScenarioStateLedger } from '../../types/votingPass';
import type { CurrencyPassDeps } from '../currencyAuto';
import type { ScenarioDocument } from '../../settings/scenarioSchema';
import type { PassContext } from '../votingOrchestrator';

type ScenarioRule = NonNullable<ScenarioDocument['phases'][string]['rules']>[number];

type ValidatedRule = ScenarioRule & { id: string };

type ScenarioAction = ScenarioRule['do'][number];

type ActionType = ScenarioAction['type'];

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
    /**
     * Set by the rule for the step it is running: writes the spend down just before its request is made (the
     * pending marker). False means it could not be written, and the spend is not made. Null where the step makes no
     * spend (a retry only looks): a spend asked for with none is refused, never made without its marker.
     */
    beforeSpend: ((action: SpendAction) => boolean) | null;
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

// `unclear`: the spend of the step got no answer, so it may have gone through and is never spent again; `spent` is
// what the run counts against its limit for it (conservatively); `halt` ends the rule instead of resuming at the step.
type NotDoneOutcome = {
    status: 'skipped' | 'failed' | 'deferred';
    message: string;
    spent?: SpendKind;
    unclear?: SpendAction;
    halt?: true;
    /** `pending`: the rule is stopped from a marker written before the spend, not from a spend that got no answer. */
    origin?: 'pending';
};

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
    ActionOutcome,
    ActionHandler,
};
