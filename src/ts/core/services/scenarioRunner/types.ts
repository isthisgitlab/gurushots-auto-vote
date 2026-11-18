/**
 * Types shared by the scenario runner's modules.
 */

import type {
    Challenge,
    ChallengeMember,
    CompletedChallenge,
    MemberRanking,
    RankingEntry,
} from '../../types/gurushots';
import type { ScenarioState, SpendAction } from '../../types/stores';
import type { ScenarioStateLedger } from '../../types/votingPass';
import type { StateLock } from '../../scenarioStateStore';
import type { CurrencyPassDeps } from '../currencyAuto';
import type { ScenarioDocument } from '../../settings/scenarioSchema';
import type { PassContext } from '../votingOrchestrator';
import type { ClaimDeps } from '../autoClaim';
import type {
    ActionEffects,
    ActionOutcome,
    DoneOutcome,
    NotDoneOutcome,
    OperationRecord,
    SpendKind,
} from '../../scenarios/runtime';
import type { AccountReads } from './facts';

type ScenarioRule = NonNullable<ScenarioDocument['phases'][string]['rules']>[number];

type ValidatedRule = ScenarioRule & { id: string };

type ScenarioAction = ScenarioRule['do'][number];

type ActionType = ScenarioAction['type'];

type SwapPhoto = { id: string; member_id: string };

/**
 * The pass as the runner reads it: every host that runs scenarios also passes
 * the currency endpoints.
 */
type ScenarioPass = PassContext & { currency: CurrencyPassDeps };

/**
 * What a settings action asks of the subject's published overlay: whether the settings of a candidate record (the record
 * with a patch or a profile applied) can be prepared, and the overlay made again for the record as it now stands.
 */
type OverlayControl = {
    /** Why the settings of `candidate` cannot be prepared (nothing is written), or null when they can. */
    check: (candidate: ScenarioState) => Promise<string | null>;
    republish: () => Promise<void>;
};

type RunnerBase = {
    /** The key of the subject's record in the progress ledger: a challenge id, or the installation's. */
    challengeId: string;
    scenario: ScenarioDocument;
    timezone: string;
    ledger: ScenarioStateLedger;
    /** The cross-process lock of the subject's steps that this step runs under (none where one process runs them). */
    stepLock?: StateLock;
    /**
     * Set by the rule for the step it is running: writes the spend down just before its request is made (the
     * pending marker). False means it could not be written, and the spend is not made. Null where the step makes no
     * spend (a retry only looks): a spend asked for with none is refused, never made without its marker.
     */
    beforeSpend: ((action: SpendAction) => boolean) | null;
    /** How the subject is named in the log: a challenge's tag, or the installation. */
    tag: string;
    /** The account reads the subject's evidence is worked out from. */
    reads: AccountReads;
    /** What the pass (a scenario action or the normal automation) already did for which subject. */
    operations: OperationRecord;
};

/** A joined challenge in the voting pass: the whole pass is at hand. */
type ActiveContext = RunnerBase & {
    stage: 'active';
    challenge: Challenge;
    pass: ScenarioPass;
    /** Whether GuruShots sent a swap history for the challenge, as the pass read it (the automatic swap's cap branch). */
    swapHistorySent: boolean;
};

/** What a candidate's join step may call: the join of that candidate, under the join pass's own decision and budget. */
type JoinAttempt = { status: string; charged: number; maybeCharged: number };

/**
 * A join of the candidate: `direct` (the default) is the scenario's own decision (no timing window, a price limit that only
 * narrows the caps); `normal` is the Auto Join pass's own decision, under its enable, timing and selection policy.
 */
type ScenarioJoin = (maxCoins: number | null, policy?: 'direct' | 'normal') => Promise<JoinAttempt>;

/** An open challenge the account has not joined, inside the join pass. */
type PreJoinContext = RunnerBase & {
    stage: 'preJoin';
    challenge: Challenge;
    join: ScenarioJoin;
};

/** The claim endpoints a reward step uses, and the needs it counts down. */
type ClaimPass = { deps: ClaimDeps };

/** A closed challenge as the completed listing gives it. */
type PostCloseContext = RunnerBase & { stage: 'postClose'; completed: CompletedChallenge; claims: ClaimPass };

/** The installation: no challenge. `republish` publishes the overlay again after a change of phase or progress. */
type AccountContext = RunnerBase & { stage: 'account'; claims: ClaimPass; overlay: OverlayControl };

type RunnerContext = ActiveContext | PreJoinContext | PostCloseContext | AccountContext;

/**
 * A challenge an action has just acted on: the action's own reads (the entry
 * it picked, the boost/turbo state it checked) or the spend that landed on it
 * establish the member tree the local reflect-writes touch.
 */
type ActedChallenge = Challenge & {
    member: ChallengeMember & { ranking: MemberRanking & { entries: RankingEntry[] } };
};

/** A subject whose settings overlay a settings action can change: a candidate, a joined challenge, the installation. */
type OverlayContext = PreJoinContext | ActiveContext | AccountContext;

/** The context an action's handler runs in: the stage the action belongs to. */
type ContextOf<K extends ActionType> = K extends 'join'
    ? PreJoinContext
    : K extends 'claimChallengeReward'
      ? PostCloseContext
      : K extends 'claimMissionReward'
        ? AccountContext
        : K extends 'goto' | 'notify' | 'pauseScenario' | 'handoffScenario'
          ? RunnerContext
          : K extends 'runAutomation'
            ? PreJoinContext | ActiveContext
            : K extends 'setSetting' | 'clearSetting'
              ? OverlayContext
              : K extends 'useProfile'
                ? PreJoinContext | ActiveContext
                : ActiveContext;

type ActionHandler<A extends ScenarioAction, C extends RunnerContext = RunnerContext> = (
    action: A,
    ctx: C,
    state: ScenarioState,
) => Promise<ActionOutcome>;

export type {
    ValidatedRule,
    ScenarioAction,
    ActionType,
    SpendAction,
    SpendKind,
    SwapPhoto,
    ScenarioPass,
    RunnerContext,
    ActiveContext,
    PreJoinContext,
    PostCloseContext,
    AccountContext,
    OverlayContext,
    JoinAttempt,
    ScenarioJoin,
    ContextOf,
    ActedChallenge,
    ActionEffects,
    DoneOutcome,
    NotDoneOutcome,
    ActionOutcome,
    ActionHandler,
};
