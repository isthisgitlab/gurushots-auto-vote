/**
 * Helpers the scenario actions share: outcomes, live refresh and currency spends.
 */

import * as logger from '../../logger';
import * as settings from '../../settings';
import { reserveAllows, lockedSpend } from '../currencyAuto';
import { CURRENCY_OUTCOME } from '../../voting/currencyActions';
import { refreshChallengeState } from '../autoFill';
import type { BoostState } from '../../types/gurushots';
import type { ScenarioState } from '../../types/stores';
import type { SpendOutcome } from '../currencyActions';
import type {
    ActionEffects,
    ActiveContext,
    ActionOutcome,
    DoneOutcome,
    JoinAttempt,
    NotDoneOutcome,
    ScenarioAction,
    SpendAction,
    SpendKind,
} from './types';

const log = () => logger.withCategory('scenario');

const LABEL = 'scenario';

/**
 * Boost states in which a boost can be applied to an entry.
 */
const BOOST_APPLICABLE: ReadonlySet<BoostState | undefined> = new Set(['AVAILABLE', 'AVAILABLE_KEY']);

/**
 * Currency each spending action draws on, and its `limits` / `spent` key.
 */
const SPEND: Record<SpendAction, { action: 'swap' | 'key' | 'fill'; limit: SpendKind; label: string }> = {
    swap: { action: 'swap', limit: 'swaps', label: 'photo swap' },
    unlockBoost: { action: 'key', limit: 'keys', label: 'boost unlock' },
    fillExposure: { action: 'fill', limit: 'fills', label: 'exposure fill' },
};

/**
 * Whether the action spends currency (and so gets the write-ahead marker and the "no answer" protocol).
 */
const isSpend = (action: ScenarioAction): action is ScenarioAction & { type: SpendAction } =>
    Object.hasOwn(SPEND, action.type);

// The spends a `runAutomation` operation makes through the normal automation's own runner.
const AUTOMATION_SPEND: Readonly<Record<string, SpendAction | undefined>> = {
    unlockBoost: 'unlockBoost',
    swap: 'swap',
    fillExposure: 'fillExposure',
};

/**
 * The currency spend a step may make, if any: a spending action, or a `runAutomation` of a spending operation. It is the
 * identity the step's write-ahead marker, its unclear marker and its limit go by.
 */
const spendOf = (action: ScenarioAction): SpendAction | undefined =>
    action.type === 'runAutomation' ? AUTOMATION_SPEND[action.operation] : isSpend(action) ? action.type : undefined;

/**
 * What a spend is given to make its request with: it sends the request only after the spend is written down.
 */
type SpendRequest = (send: () => Promise<SpendOutcome>) => Promise<SpendOutcome>;

/**
 * The retry of a step whose spend is not known to have been made: whether it still has to be counted (it was only
 * written down before, never counted) and what it came from (GuruShots giving no answer, or the app not recording).
 */
type Retry = { count: boolean; origin: 'unclear' | 'pending' };

// The outcome of a spend that was not made because its marker could not be written down first.
const NOT_WRITTEN = 'not-written';

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * The scenario `limits` / `spent` key a spend counts against.
 */
const limitOf = (actionType: SpendAction): SpendKind => SPEND[actionType].limit;

const done = (effects: ActionEffects = {}): DoneOutcome => ({ status: 'done', ...effects });
const skipped = (message: string): NotDoneOutcome => ({ status: 'skipped', message });
const failed = (message: string): NotDoneOutcome => ({ status: 'failed', message });
const deferred = (message: string): NotDoneOutcome => ({ status: 'deferred', message });

/**
 * What a join attempt comes to as a step. Joined is done. Paid for (or possibly paid for) and not entered: the step is retried,
 * the claim on file makes the retry submit only (it never unlocks again), and the coins count against the limit as spent.
 * Any other refusal: a skip under the scenario's own decision (`direct`); under the pass's normal policy (`normal`) a
 * refusal that spent nothing is the policy saying not now, which completes the step and says why.
 */
const joinOutcome = (attempt: JoinAttempt, policy: 'direct' | 'normal'): ActionOutcome => {
    const coins = attempt.charged + attempt.maybeCharged;
    if (attempt.status === 'joined') return done({ coins });
    if (attempt.status === 'charged-pending-submit') {
        return {
            ...failed('the join is paid for but not completed yet; it is retried without paying again'),
            coins,
            resume: true,
        };
    }
    const message = `the join was not made (${attempt.status})`;
    if (attempt.status === 'busy') return deferred(message);
    if (attempt.status === 'failed-no-charge' || attempt.status === 'error') return failed(message);
    return policy === 'normal' ? done({ notDue: attempt.status }) : skipped(message);
};

/**
 * The end of a rule whose spend got no answer and cannot be shown to have taken effect: it is not spent again, and
 * the rule stops rather than going on to spend on a later step.
 */
const unclearHalted = (actionType: SpendAction, from: Retry): NotDoneOutcome => ({
    ...failed(
        from.origin === 'pending'
            ? `the app did not record whether the ${SPEND[actionType].label} was sent or what came of it, so it may have gone through and is not repeated, and the rule was stopped`
            : `the ${SPEND[actionType].label} may have gone through earlier, so it is not repeated and the rule was stopped`,
    ),
    unclear: actionType,
    halt: true,
    ...(from.origin === 'pending' ? { origin: 'pending' as const } : {}),
    // A spend recovered from its marker was never counted: it is now, as if it had gone through.
    ...(from.count ? { spent: SPEND[actionType].limit } : {}),
});

/**
 * Re-read the challenge live (merged into the pass object in place).
 *
 * @returns null when the live state is good to act on; otherwise the outcome the step returns: the challenge left
 * the active list (skipped), or the read cannot be trusted — a marked challenge, or a prune-unsafe read that may
 * have dropped it (deferred: the step stops its rule and is retried on the next pass, never on data the boundary
 * could not vouch for).
 */
const refreshLive = async (ctx: ActiveContext): Promise<NotDoneOutcome | null> => {
    const refresh = await refreshChallengeState(
        ctx.challenge,
        ctx.pass.token,
        { getActiveChallenges: ctx.pass.api.getActiveChallenges, logger },
        LABEL,
    );
    if (refresh === 'gone') return skipped('the challenge is no longer active');
    if (refresh === 'invalid') return deferred('challenge data cannot be read');
    return null;
};

/**
 * The outcome of a spend that got no answer, and of a settle whose re-read cannot be trusted: the spend may have
 * gone through, so it is checked again next cycle, never spent again, and counted against the scenario's limit as
 * if it had.
 */
const noAnswer = (actionType: SpendAction, spent: boolean): NotDoneOutcome => ({
    ...failed(
        `the ${SPEND[actionType].label} may have gone through (GuruShots gave no answer); it will be checked again next cycle, not spent again`,
    ),
    unclear: actionType,
    ...(spent ? { spent: SPEND[actionType].limit } : {}),
});

/**
 * Shared gate for the currency spends: the scenario's own limit, then the
 * user's reserve.
 *
 * @returns why the spend is blocked, or null when allowed
 */
const spendAllowed = async (
    actionType: SpendAction,
    ctx: ActiveContext,
    state: ScenarioState,
): Promise<string | null> => {
    const spend = SPEND[actionType];
    const limit = ctx.scenario.limits?.[spend.limit];
    if (limit !== undefined && (state.spent[spend.limit] ?? 0) >= limit) {
        return `the scenario's ${spend.limit} limit of ${limit} is reached`;
    }
    const reserveCtx = { challenge: ctx.challenge, token: ctx.pass.token, currency: ctx.pass.currency };
    return (await reserveAllows(spend.action, reserveCtx, LABEL))
        ? null
        : `the ${spend.limit} reserve would be crossed`;
};

/**
 * Spend outcomes worth retrying; every other refusal (no balance, no alternative photo, the entry moved on) is a skip.
 * `data-incomplete` (the live check refused a marked challenge, or the read that would list it dropped elements)
 * retries too: a committed rule must never pass over a spend whose precondition could not be read.
 */
const TRANSIENT_OUTCOMES: ReadonlySet<string> = new Set([
    CURRENCY_OUTCOME.apiFailed,
    CURRENCY_OUTCOME.balanceUnknown,
    CURRENCY_OUTCOME.busy,
    CURRENCY_OUTCOME.dataIncomplete,
]);

/**
 * Runs a currency spend under the shared lock; `deferred` when another spend holds it.
 *
 * @returns null when the spend went through
 */
const lockedCurrencySpend = async (
    actionType: SpendAction,
    ctx: ActiveContext,
    spend: (request: SpendRequest) => Promise<SpendOutcome>,
): Promise<NotDoneOutcome | null> => {
    // The only way a spend's request is made: the marker is written down first, and a request whose marker could not
    // be written (or that has no way to write one) is not made. Whatever the spend does before its request (a
    // preview, say) leaves no marker if it is refused there.
    // It serves one request: a second call is refused, with no second marker and no second spend.
    let used = false;
    const request: SpendRequest = async (send) => {
        if (used) return { ok: false, outcome: NOT_WRITTEN };
        used = true;
        return ctx.beforeSpend?.(actionType) ? send() : { ok: false, outcome: NOT_WRITTEN };
    };
    const result = await lockedSpend(SPEND[actionType].action, ctx.challenge, () => spend(request), LABEL);
    if (result === null) return { status: 'deferred', message: 'another spend is in progress' };
    // Every spend resolves {ok, outcome}; null is reserved for a busy lock.
    if (result.ok) return null;
    if (result.outcome === NOT_WRITTEN) {
        return {
            status: 'deferred',
            message: `the ${SPEND[actionType].label} could not be written down first, so it was not made`,
        };
    }
    // No answer: the spend may have gone through, so the step is retried (the live re-read guards the repeat) and
    // counted against the scenario's limit as if it had.
    if (result.outcome === CURRENCY_OUTCOME.unclear) return noAnswer(actionType, true);
    const message = `${actionType} was refused (${result.outcome ?? 'no response'})`;
    return result.outcome === undefined || TRANSIENT_OUTCOMES.has(result.outcome) ? failed(message) : skipped(message);
};

const currencyDeps = (ctx: ActiveContext) => ({ strategy: ctx.pass.currency.strategy, logger, settings });

/**
 * The photo a `with` / `photo` source names: a remembered id, or null for "best".
 * undefined when the memory slot is empty.
 */
const rememberedPhoto = (source: 'best' | { memory: string }, state: ScenarioState): string | null | undefined =>
    source === 'best' ? null : (state.memory[source.memory] ?? undefined);

export {
    log,
    BOOST_APPLICABLE,
    nowSec,
    limitOf,
    isSpend,
    spendOf,
    done,
    skipped,
    failed,
    deferred,
    joinOutcome,
    refreshLive,
    spendAllowed,
    lockedCurrencySpend,
    noAnswer,
    unclearHalted,
    currencyDeps,
    rememberedPhoto,
};
export type { Retry };
