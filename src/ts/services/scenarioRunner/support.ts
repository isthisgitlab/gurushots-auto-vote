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
import type { ScenarioDocument } from '../../settings/scenarioSchema';
import type {
    ActionEffects,
    DoneOutcome,
    NotDoneOutcome,
    RunnerContext,
    ScenarioRule,
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
const SPEND: Record<SpendAction, { action: 'swap' | 'key' | 'fill'; limit: SpendKind }> = {
    swap: { action: 'swap', limit: 'swaps' },
    unlockBoost: { action: 'key', limit: 'keys' },
    fillExposure: { action: 'fill', limit: 'fills' },
};

const nowSec = () => Math.floor(Date.now() / 1000);

const done = (effects: ActionEffects = {}): DoneOutcome => ({ status: 'done', ...effects });
const skipped = (message: string): NotDoneOutcome => ({ status: 'skipped', message });
const failed = (message: string): NotDoneOutcome => ({ status: 'failed', message });

/**
 * True when any rule of the scenario compares a currency balance.
 */
const usesBalance = (scenario: ScenarioDocument) => {
    const walk = (conditions: ScenarioRule['if']): boolean =>
        (conditions ?? []).some(
            (item) =>
                item.type === 'balance' ||
                ((item.type === 'any' || item.type === 'all') && walk(item.of)) ||
                (item.type === 'not' && walk([item.condition])),
        );
    return Object.values(scenario.phases).some((phase) => (phase.rules ?? []).some((rule) => walk(rule.if)));
};

/**
 * Re-read the challenge live (merged into the pass object in place). Returns
 * false only when the challenge left the active list; an unavailable fetch
 * proceeds on the data at hand, as the fill paths do.
 */
const refreshLive = async (ctx: RunnerContext) =>
    (await refreshChallengeState(
        ctx.challenge,
        ctx.pass.token,
        { getActiveChallenges: ctx.pass.api.getActiveChallenges, logger },
        LABEL,
    )) !== 'gone';

/**
 * Shared gate for the currency spends: the scenario's own limit, then the
 * user's reserve.
 *
 * @returns why the spend is blocked, or null when allowed
 */
const spendAllowed = async (
    actionType: SpendAction,
    ctx: RunnerContext,
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
 */
const TRANSIENT_OUTCOMES: ReadonlySet<string> = new Set([
    CURRENCY_OUTCOME.apiFailed,
    CURRENCY_OUTCOME.balanceUnknown,
    CURRENCY_OUTCOME.busy,
]);

/**
 * Runs a currency spend under the shared lock; `deferred` when another spend holds it.
 *
 * @returns null when the spend went through
 */
const lockedCurrencySpend = async (
    actionType: SpendAction,
    ctx: RunnerContext,
    spend: () => Promise<SpendOutcome>,
): Promise<NotDoneOutcome | null> => {
    const result = await lockedSpend(SPEND[actionType].action, ctx.challenge, spend, LABEL);
    if (result === null) return { status: 'deferred', message: 'another spend is in progress' };
    // Every spend resolves {ok, outcome}; null is reserved for a busy lock.
    if (result.ok) return null;
    const message = `${actionType} was refused (${result.outcome ?? 'no response'})`;
    return result.outcome === undefined || TRANSIENT_OUTCOMES.has(result.outcome) ? failed(message) : skipped(message);
};

const currencyDeps = (ctx: RunnerContext) => ({ strategy: ctx.pass.currency.strategy, logger, settings });

/**
 * What entry selectors read: remembered photos, and vote history for `fastest`.
 */
const selectContext = (state: ScenarioState) => ({ memory: state.memory, history: state.history, now: nowSec() });

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
    done,
    skipped,
    failed,
    usesBalance,
    refreshLive,
    spendAllowed,
    lockedCurrencySpend,
    currencyDeps,
    selectContext,
    rememberedPhoto,
};
