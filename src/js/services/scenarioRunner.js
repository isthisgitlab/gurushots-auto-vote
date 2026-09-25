/**
 * Runs a challenge's user-defined scenario inside the voting pass: evaluates
 * it (scenarios/evaluate.js), executes the chosen rule's actions over the
 * existing primitives, and persists where the challenge now is in its plan
 * (scenarioStateStore.js). Called by processChallenge before the built-in
 * steps, so they then run under the current phase's settings overlay.
 *
 * Contracts:
 *   - Before each action the challenge is re-read live and the action's entry
 *     re-resolved; an action whose target or precondition is gone is SKIPPED
 *     (logged, shown as the last problem), never forced.
 *   - Once an action of a rule has gone through, the rule is committed: its
 *     progress is persisted after every action, so a crash never repeats a
 *     spend that landed. After that, a SKIPPED action is passed over and the
 *     rule carries on (a permanent skip — the boost already used, the photo
 *     already entered — must not freeze the plan before its `goto`), while a
 *     FAILED or deferred action (the server refused, the spend lock was busy
 *     — worth retrying) resumes at that action next pass.
 *     A rule whose first action does not go through is simply not fired, so a
 *     skip never uses up a `once` rule.
 *   - No spend cap: each rule fires at most once per pass (a condition the
 *     action cannot change in-pass would otherwise re-fire it), and a `goto`
 *     chain stops when it comes back to a phase already visited this pass.
 *     Currency spends honour the user's own currencyReserve* settings and the
 *     scenario's optional `limits`.
 *   - Never throws into the pass; a failure is logged and recorded as the
 *     challenge's lastError for the status line.
 */

const logger = require('../logger');
const settings = require('../settings');
const runtime = require('../runtime');
const nativeAutovote = require('./NativeAutovoteBridge');
const { DEFAULT_TIMEZONE } = require('../settings/uiDefaults');
const currencyActions = require('./currencyActions');
const { reserveAllows, lockedSpend } = require('./currencyAuto');
const { CURRENCY_OUTCOME } = require('../voting/currencyActions');
const {
    submitNewEntryForAction,
    reflectNewEntry,
    reflectEntryFlag,
    refreshChallengeState,
    getSlotsRemaining,
} = require('./autoFill');
const { evaluateScenario, firedRecord } = require('../scenarios/evaluate');
const { selectEntry, entriesOf } = require('../scenarios/selectors');
const { initialState } = require('../scenarioStateStore');

const log = () => logger.withCategory('scenario');

const LABEL = 'scenario';

/** Boost states in which a boost can be applied to an entry. */
const BOOST_APPLICABLE = new Set(['AVAILABLE', 'AVAILABLE_KEY']);

/** Currency each spending action draws on, and its `limits` / `spent` key. */
const SPEND = {
    swap: { action: 'swap', limit: 'swaps' },
    unlockBoost: { action: 'key', limit: 'keys' },
    fillExposure: { action: 'fill', limit: 'fills' },
};

const nowSec = () => Math.floor(Date.now() / 1000);

const done = (effects = {}) => ({ status: 'done', ...effects });
const skipped = (message) => ({ status: 'skipped', message });
const failed = (message) => ({ status: 'failed', message });

/** True when any rule of the scenario compares a currency balance. */
const usesBalance = (scenario) => {
    const walk = (conditions) =>
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
const refreshLive = async (ctx) =>
    (await refreshChallengeState(
        ctx.challenge,
        ctx.pass.token,
        { getActiveChallenges: ctx.pass.api.getActiveChallenges, logger },
        LABEL,
    )) !== 'gone';

/**
 * Shared gate for the currency spends: the scenario's own limit, then the
 * user's reserve.
 */
const spendAllowed = async (actionType, ctx, state) => {
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

/** Spend outcomes worth retrying; every other refusal (no balance, no alternative photo, the entry moved on) is a skip. */
const TRANSIENT_OUTCOMES = new Set([
    CURRENCY_OUTCOME.apiFailed,
    CURRENCY_OUTCOME.balanceUnknown,
    CURRENCY_OUTCOME.busy,
]);

/** Runs a currency spend under the shared lock; `deferred` when another spend holds it. */
const lockedCurrencySpend = async (actionType, ctx, spend) => {
    const result = await lockedSpend(SPEND[actionType].action, ctx.challenge, spend, LABEL);
    if (result === null) return { status: 'deferred', message: 'another spend is in progress' };
    // Every spend resolves {ok, outcome}; null is reserved for a busy lock.
    if (result.ok) return null;
    const message = `${actionType} was refused (${result.outcome ?? 'no response'})`;
    return result.outcome === undefined || TRANSIENT_OUTCOMES.has(result.outcome) ? failed(message) : skipped(message);
};

const currencyDeps = (ctx) => ({ strategy: ctx.pass.currency.strategy, logger, settings });

/** The photo a `with` / `photo` source names: a remembered id, or null for "best". */
const rememberedPhoto = (source, state) => (source === 'best' ? null : (state.memory[source.memory] ?? undefined));

const ACTIONS = {
    enterPhoto: async (action, ctx, state) => {
        const { challenge, pass } = ctx;
        const photoId = rememberedPhoto(action.photo, state);
        if (photoId === undefined) return skipped(`memory slot "${action.photo.memory}" is empty`);
        let enteredId = photoId;
        if (photoId === null) {
            // The fill path re-reads the challenge live and checks the free slots itself.
            const filled = await submitNewEntryForAction(challenge, pass.token, pass.fillDeps);
            if (filled.reason === 'no-slots') return skipped('no free entry slot');
            if (filled.reason === 'challenge-gone') return skipped('the challenge is no longer active');
            if (filled.reason === 'no-eligible') return skipped('no eligible photo to enter');
            if (!filled.ok) return failed(`no photo was entered (${filled.reason})`);
            enteredId = String(filled.imageId);
        } else {
            if (!(await refreshLive(ctx))) return skipped('the challenge is no longer active');
            if (getSlotsRemaining(challenge) <= 0) return skipped('no free entry slot');
            if (entriesOf(challenge).some((entry) => String(entry.id) === photoId)) {
                return skipped(`photo ${photoId} is already entered`);
            }
            const result = await pass.api.submitToChallenge(challenge.id, [photoId], pass.token);
            if (!result?.ok) return failed(`photo ${photoId} could not be entered`);
        }
        reflectNewEntry(challenge, enteredId);
        return done({ remember: action.remember ? { [action.remember]: enteredId } : {} });
    },

    swap: async (action, ctx, state) => {
        const { challenge, pass } = ctx;
        const newPhoto = rememberedPhoto(action.with, state);
        if (newPhoto === undefined) return skipped(`memory slot "${action.with.memory}" is empty`);
        if (!(await refreshLive(ctx))) return skipped('the challenge is no longer active');
        const target = selectEntry(action.entry, challenge, state.memory);
        if (!target) return skipped('no entry matches the swap target');
        if (newPhoto !== null && entriesOf(challenge).some((entry) => String(entry.id) === newPhoto)) {
            return skipped(`photo ${newPhoto} is already entered`);
        }
        const blocked = await spendAllowed('swap', ctx, state);
        if (blocked) return skipped(blocked);

        let replacement = newPhoto === null ? null : { id: newPhoto, member_id: String(target.member_id ?? '') };
        const refused = await lockedCurrencySpend('swap', ctx, async () => {
            if (replacement === null) {
                const preview = await currencyActions.previewSwap(
                    challenge.id,
                    target.id,
                    pass.token,
                    currencyDeps(ctx),
                );
                if (!preview?.ok) return preview;
                replacement = preview.candidate;
            }
            return currencyActions.swapEntry(challenge.id, target.id, replacement.id, pass.token, {
                ...currencyDeps(ctx),
                ledger: pass.currency.swapLedger ?? null,
            });
        });
        if (refused) return refused;

        const entries = challenge.member.ranking.entries;
        entries[entries.indexOf(target)] = { id: replacement.id, member_id: replacement.member_id };
        const ranking = challenge.member.ranking;
        ranking.swaps = [...(Array.isArray(ranking.swaps) ? ranking.swaps : []), { id: String(target.id) }];
        const remember = {};
        if (action.rememberRemoved) remember[action.rememberRemoved] = String(target.id);
        if (action.rememberAdded) remember[action.rememberAdded] = String(replacement.id);
        return done({ remember, spent: 'swaps' });
    },

    boost: async (action, ctx, state) => {
        const { challenge, pass } = ctx;
        if (!(await refreshLive(ctx))) return skipped('the challenge is no longer active');
        if (!BOOST_APPLICABLE.has(challenge.member?.boost?.state)) {
            return skipped(`the boost is not available (${challenge.member?.boost?.state ?? 'unknown'})`);
        }
        const target = selectEntry(action.entry, challenge, state.memory);
        if (!target) return skipped('no entry matches the boost target');
        const response = await pass.api.applyBoostToEntry(challenge.id, String(target.id), pass.token);
        if (!response) return failed(`the boost on entry ${target.id} was refused`);
        reflectEntryFlag(challenge, target.id, 'boosted');
        challenge.member.boost = { ...challenge.member.boost, state: 'USED' };
        return done();
    },

    turbo: async (action, ctx, state) => {
        const { challenge, pass } = ctx;
        if (!(await refreshLive(ctx))) return skipped('the challenge is no longer active');
        if (challenge.member?.turbo?.state !== 'WON') {
            return skipped(`no won turbo to apply (${challenge.member?.turbo?.state ?? 'unknown'})`);
        }
        const target = selectEntry(action.entry, challenge, state.memory);
        if (!target) return skipped('no entry matches the turbo target');
        const result = await pass.api.applyTurbo(challenge.id, String(target.id), pass.token);
        if (!result?.ok) return failed(`the turbo on entry ${target.id} was refused`);
        reflectEntryFlag(challenge, target.id, 'turbo');
        challenge.member.turbo = { ...challenge.member.turbo, state: 'USED' };
        return done();
    },

    unlockBoost: async (action, ctx, state) => {
        const blocked = await spendAllowed('unlockBoost', ctx, state);
        if (blocked) return skipped(blocked);
        const refused = await lockedCurrencySpend('unlockBoost', ctx, () =>
            currencyActions.unlockBoostWithKey(ctx.challenge.id, ctx.pass.token, currencyDeps(ctx)),
        );
        if (refused) return refused;
        ctx.challenge.member.boost = { ...ctx.challenge.member.boost, state: 'AVAILABLE_KEY', timeout: null };
        return done({ spent: 'keys' });
    },

    fillExposure: async (action, ctx, state) => {
        const blocked = await spendAllowed('fillExposure', ctx, state);
        if (blocked) return skipped(blocked);
        const refused = await lockedCurrencySpend('fillExposure', ctx, () =>
            currencyActions.fillExposure(ctx.challenge.id, ctx.pass.token, currencyDeps(ctx)),
        );
        if (refused) return refused;
        const ranking = ctx.challenge.member.ranking;
        ranking.exposure = { ...ranking.exposure, exposure_factor: 100 };
        return done({ spent: 'fills' });
    },

    vote: async (action, ctx) => {
        const { challenge, pass } = ctx;
        const voteImages = await pass.api.getVoteImages(challenge, pass.token);
        if (!voteImages) return failed('the vote images could not be loaded');
        const response = await pass.api.submitVotes(voteImages, pass.token, action.toExposure);
        return response ? done() : failed('the votes could not be submitted');
    },

    remember: async (action, ctx, state) => {
        const target = selectEntry(action.entry, ctx.challenge, state.memory);
        if (!target) return skipped('no entry matches');
        return done({ remember: { [action.slot]: String(target.id) } });
    },

    forget: async (action) => done({ forget: action.slot }),

    goto: async (action) => done({ goto: action.phase }),
};

/** State after one action's effects. */
const applyEffects = (state, effects) => {
    const memory = { ...state.memory, ...effects.remember };
    if (effects.forget) delete memory[effects.forget];
    const spent = effects.spent
        ? { ...state.spent, [effects.spent]: (state.spent[effects.spent] ?? 0) + 1 }
        : state.spent;
    return { ...state, memory, spent };
};

/**
 * Execute one rule from `startIndex`. Returns the new state and whether the
 * rule finished (its actions all went through or were passed over).
 */
const runRule = async (fire, ctx, startState) => {
    const { rule, startIndex } = fire;
    const tag = logger.challengeTag(ctx.challenge);
    let state = startState;
    let committed = startIndex > 0;
    let gotoPhase = null;
    let skippedStep = null;
    for (let index = startIndex; index < rule.do.length; index++) {
        const action = rule.do[index];
        const result = await ACTIONS[action.type](action, ctx, state);
        const at = nowSec();
        if (result.status !== 'done') {
            const message = `${rule.label ?? rule.id} → ${action.type}: ${result.message}`;
            log().warning(`${tag} scenario "${ctx.scenario.name}": ${message}`, null);
            if (result.status === 'skipped' && committed) {
                // Committed rules pass over a skipped step and carry on.
                skippedStep = { at, message };
                state = { ...state, lastError: skippedStep, inFlight: { ruleId: rule.id, actionIndex: index + 1 } };
                ctx.ledger.set(ctx.challengeId, state);
                continue;
            }
            state = { ...state, inFlight: committed ? { ruleId: rule.id, actionIndex: index } : null };
            if (result.status !== 'deferred') state.lastError = { at, message };
            ctx.ledger.set(ctx.challengeId, state);
            return { state, completed: false };
        }
        committed = true;
        gotoPhase = result.goto ?? gotoPhase;
        state = {
            ...applyEffects(state, result),
            inFlight: { ruleId: rule.id, actionIndex: index + 1 },
            lastAction: { at, ruleId: rule.id, action: action.type, outcome: 'done' },
        };
        ctx.ledger.set(ctx.challengeId, state);
        log().info(`${tag} scenario "${ctx.scenario.name}": ${rule.label ?? rule.id} → ${action.type}`, null);
    }
    const at = nowSec();
    state = {
        ...state,
        inFlight: null,
        // A step passed over in this firing stays visible as the last problem.
        lastError: skippedStep,
        fired: { ...state.fired, [rule.id]: firedRecord(startState, at, ctx.timezone) },
    };
    // A phase change takes effect when the rule finishes, so an interrupted
    // rule always resumes in the phase it belongs to.
    if (gotoPhase !== null && gotoPhase !== state.phase) {
        log().info(`${tag} scenario "${ctx.scenario.name}": phase ${state.phase} → ${gotoPhase}`, null);
        state = { ...state, phase: gotoPhase, phaseEnteredAt: at };
    }
    ctx.ledger.set(ctx.challengeId, state);
    return { state, completed: true };
};

/**
 * The challenge's state for `scenario`, starting it (at the start phase) when
 * it has none or was running a different scenario. Null when unreadable.
 */
const loadState = (ctx, now) => {
    const { corrupt, state } = ctx.ledger.get(ctx.challengeId);
    if (corrupt) {
        log().error(
            `${logger.challengeTag(ctx.challenge)} scenario state is unreadable — reset it (scenario-reset) to start the plan again`,
            null,
        );
        return null;
    }
    if (state && state.scenario.toLowerCase() === ctx.scenario.name.toLowerCase()) return state;
    const fresh = initialState(ctx.scenario.name, ctx.scenario.start, now);
    ctx.ledger.set(ctx.challengeId, fresh);
    log().info(
        `${logger.challengeTag(ctx.challenge)} scenario "${ctx.scenario.name}" started in phase ${fresh.phase}`,
        null,
    );
    return fresh;
};

/**
 * One pass's scenario step for a challenge. No-op when the pass has no
 * scenario deps, the host defers scenarios to another loop, or the
 * challenge has no (known) scenario.
 *
 * @param {object} challenge
 * @param {number} now - unix seconds
 * @param {object} pass - the voting pass context (token, api, fillDeps, currency, scenarios)
 */
const runScenarioStep = async (challenge, now, pass) => {
    const deps = pass.scenarios;
    if (!deps || (deps.enabled && !deps.enabled())) return;
    try {
        const challengeId = String(challenge.id);
        const name = settings.getEffectiveSetting('scenario', challengeId);
        if (!name) return;
        const scenario = settings.getScenario(name);
        if (!scenario) {
            log().warning(
                `${logger.challengeTag(challenge)} has scenario "${name}", which does not exist — nothing runs`,
                null,
            );
            return;
        }
        const timezone = settings.getSetting('timezone') || DEFAULT_TIMEZONE;
        const ctx = { challenge, challengeId, scenario, timezone, pass, ledger: deps.ledger };
        let state = loadState(ctx, now);
        if (!state) return;

        const firedThisPass = new Set();
        const visited = new Set([state.phase]);
        const needsBankroll = usesBalance(scenario);
        for (;;) {
            const bankroll = needsBankroll ? await pass.currency.strategy.getBankroll(pass.token) : null;
            const decision = evaluateScenario({
                scenario,
                state,
                challenge,
                now: nowSec(),
                timezone,
                bankroll,
                skipRuleIds: firedThisPass,
            });
            if (decision.halted) {
                if (state.lastError?.message !== decision.halted) {
                    state = { ...state, lastError: { at: nowSec(), message: decision.halted } };
                    ctx.ledger.set(challengeId, state);
                }
                log().error(`${logger.challengeTag(challenge)} scenario halted: ${decision.halted}`, null);
                return;
            }
            if (!decision.fire) return;
            firedThisPass.add(decision.fire.ruleId);
            const outcome = await runRule(decision.fire, ctx, state);
            state = outcome.state;
            if (!outcome.completed) return;
            if (!visited.has(state.phase)) {
                visited.add(state.phase);
            } else if (decision.fire.rule.do.some((action) => action.type === 'goto')) {
                log().warning(
                    `${logger.challengeTag(challenge)} scenario "${scenario.name}" came back to phase ${state.phase} in one pass — continuing next pass`,
                    null,
                );
                return;
            }
        }
    } catch (error) {
        log().error(`${logger.challengeTag(challenge)} scenario step failed: ${error?.message || error}`, null);
    }
};

/**
 * True in the Android app WebView when the native background service is
 * available: that service runs its own voting pass (and its own copy of the
 * scenario state) alongside the in-app loop, so it alone advances scenarios.
 */
const backgroundServiceOwnsScenarios = () =>
    runtime.isCapacitor() && !runtime.isHeadlessService() && nativeAutovote.isAvailable();

module.exports = { runScenarioStep, backgroundServiceOwnsScenarios };
