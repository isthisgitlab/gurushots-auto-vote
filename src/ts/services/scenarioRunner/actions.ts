/**
 * The scenario action handlers.
 *
 * Contract: see the runner contract in the scenarioRunner.ts header (live re-read
 * before each action, persist after each, unreadable state halts).
 */

import * as settings from '../../settings';
import * as currencyActions from '../currencyActions';
import { isManualPhotosOnly } from '../manualPhotosOnly';
import { submitNewEntryForAction, reflectNewEntry, reflectEntryFlag, getSlotsRemaining } from '../autoFill';
import { selectEntry, entriesOf } from '../../scenarios/selectors';
import { isGuruPicked } from '../../voting/currencyAuto';
import { isKeyUnlockedBoost } from '../../voting/boostWindow';
import { isKnownTurboMode } from '../../voting/turboMode';
import type {
    ActedChallenge,
    ActionHandler,
    ActionOutcome,
    ActionType,
    RunnerContext,
    ScenarioAction,
    SpendAction,
    SwapPhoto,
} from './types';
import type { ScenarioState } from '../../types/stores';
import {
    BOOST_APPLICABLE,
    currencyDeps,
    deferred,
    done,
    failed,
    lockedCurrencySpend,
    noAnswer,
    refreshLive,
    rememberedPhoto,
    selectContext,
    skipped,
    spendAllowed,
    unclearHalted,
    limitOf,
} from './support';
import type { Retry } from './support';

// With Manual Only on the voting pass never runs a scenario at all (votingOrchestrator.ts), so this is defence in
// depth: a step that enters or swaps a photo is skipped here too. What a skip comes to is the rule's usual skip
// semantics (scenarioRunner/rule.ts): a rule with no completed step yet stops there without firing and retries on
// later passes, so it runs once the switch is off; a rule whose earlier step already went through moves past the
// skipped step for good.
const MANUAL_PHOTOS_SKIP = 'Manual Only is on';

const ACTIONS: { [K in ActionType]: ActionHandler<Extract<ScenarioAction, { type: K }>> } = {
    enterPhoto: async (action, ctx, state) => {
        const { challenge, pass } = ctx;
        if (isManualPhotosOnly(settings, challenge.id)) return skipped(MANUAL_PHOTOS_SKIP);
        const photoId = rememberedPhoto(action.photo, state);
        if (photoId === undefined)
            return skipped(`memory slot "${(action.photo as { memory: string }).memory}" is empty`);
        let enteredId = photoId;
        if (photoId === null) {
            // The fill path re-reads the challenge live and checks the free slots itself.
            const filled = await submitNewEntryForAction(challenge, pass.token, pass.fillDeps);
            if (filled.reason === 'no-slots') return skipped('no free entry slot');
            if (filled.reason === 'challenge-gone') return skipped('the challenge is no longer active');
            if (filled.reason === 'data-incomplete') return deferred('challenge data cannot be read');
            if (filled.reason === 'no-eligible') return skipped('no eligible photo to enter');
            if (filled.reason === 'no-chosen') return skipped('no chosen photo can be entered');
            if (!filled.ok) return failed(`no photo was entered (${filled.reason})`);
            enteredId = String(filled.imageId);
        } else {
            const stale = await refreshLive(ctx);
            if (stale) return stale;
            if (getSlotsRemaining(challenge) <= 0) return skipped('no free entry slot');
            if (entriesOf(challenge).some((entry) => String(entry.id) === photoId)) {
                return skipped(`photo ${photoId} is already entered`);
            }
            const result = await pass.api.submitToChallenge(challenge.id, [photoId], pass.token);
            if (!result?.ok) return failed(`photo ${photoId} could not be entered`);
        }
        reflectNewEntry(challenge, enteredId);
        // Both paths above leave a photo id here.
        const entered = enteredId as string;
        return done({ remember: action.remember ? { [action.remember]: entered } : {} });
    },

    swap: async (action, ctx, state) => {
        const { challenge, pass } = ctx;
        if (isManualPhotosOnly(settings, challenge.id)) return skipped(MANUAL_PHOTOS_SKIP);
        const newPhoto = rememberedPhoto(action.with, state);
        if (newPhoto === undefined)
            return skipped(`memory slot "${(action.with as { memory: string }).memory}" is empty`);
        const stale = await refreshLive(ctx);
        if (stale) return stale;
        const target = selectEntry(action.entry, challenge, selectContext(state));
        if (!target) return skipped('no entry matches the swap target');
        // A refusal, not a re-selection: the selectors know nothing of guru picks, so the rule's
        // condition and its swap still resolve the same photo — the swap just never fires on one.
        if ('skipProtected' in action.entry && action.entry.skipProtected === true && isGuruPicked(target)) {
            return skipped('the swap target is guru-picked');
        }
        if (newPhoto !== null && entriesOf(challenge).some((entry) => String(entry.id) === newPhoto)) {
            return skipped(`photo ${newPhoto} is already entered`);
        }
        const blocked = await spendAllowed('swap', ctx, state);
        if (blocked) return skipped(blocked);

        let replacement: SwapPhoto | null =
            newPhoto === null ? null : { id: newPhoto, member_id: String(target.member_id ?? '') };
        const refused = await lockedCurrencySpend('swap', ctx, async (request) => {
            if (replacement === null) {
                const preview = await currencyActions.previewSwap(
                    challenge.id,
                    target.id,
                    pass.token,
                    currencyDeps(ctx),
                );
                if (!preview?.ok) return preview;
                // An ok preview always carries its candidate.
                replacement = preview.candidate as SwapPhoto;
            }
            // The preview is a read: only the swap itself is written down first.
            const photo = replacement;
            return request(() =>
                currencyActions.swapEntry(challenge.id, target.id, photo.id, pass.token, {
                    ...currencyDeps(ctx),
                    ledger: pass.currency.swapLedger ?? null,
                }),
            );
        });
        if (refused) return refused;
        // The spend went through, so the replacement was given or previewed.
        const added = replacement as SwapPhoto;

        const entries = (challenge as ActedChallenge).member.ranking.entries;
        entries[entries.indexOf(target)] = { id: added.id, member_id: added.member_id };
        const ranking = (challenge as ActedChallenge).member.ranking;
        ranking.swaps = [...(Array.isArray(ranking.swaps) ? ranking.swaps : []), { id: String(target.id) }];
        const remember: Record<string, string> = {};
        if (action.rememberRemoved) remember[action.rememberRemoved] = String(target.id);
        if (action.rememberAdded) remember[action.rememberAdded] = String(added.id);
        return done({ remember, spent: 'swaps' });
    },

    boost: async (action, ctx, state) => {
        const { challenge, pass } = ctx;
        const stale = await refreshLive(ctx);
        if (stale) return stale;
        if (!BOOST_APPLICABLE.has(challenge.member?.boost?.state)) {
            return skipped(`the boost is not available (${challenge.member?.boost?.state ?? 'unknown'})`);
        }
        const target = selectEntry(action.entry, challenge, selectContext(state));
        if (!target) return skipped('no entry matches the boost target');
        const response = await pass.api.applyBoostToEntry(challenge.id, String(target.id), pass.token);
        if (!response) return failed(`the boost on entry ${target.id} was refused`);
        reflectEntryFlag(challenge, target.id, 'boosted');
        const member = (challenge as ActedChallenge).member;
        member.boost = { ...member.boost, state: 'USED' };
        return done();
    },

    turbo: async (action, ctx, state) => {
        const { challenge, pass } = ctx;
        const stale = await refreshLive(ctx);
        if (stale) return stale;
        if (challenge.member?.turbo?.state !== 'WON') {
            return skipped(`no won turbo to apply (${challenge.member?.turbo?.state ?? 'unknown'})`);
        }
        // A turbo without a mode is the mobile copy, whose WON can be false for a Snap game.
        if (!isKnownTurboMode(challenge.member.turbo)) return skipped('the turbo mode is unknown');
        const target = selectEntry(action.entry, challenge, selectContext(state));
        if (!target) return skipped('no entry matches the turbo target');
        const result = await pass.api.applyTurbo(challenge.id, String(target.id), pass.token);
        if (!result?.ok) return failed(`the turbo on entry ${target.id} was refused`);
        reflectEntryFlag(challenge, target.id, 'turbo');
        const member = (challenge as ActedChallenge).member;
        member.turbo = { ...member.turbo, state: 'USED' };
        return done();
    },

    unlockBoost: async (action, ctx, state) => {
        const blocked = await spendAllowed('unlockBoost', ctx, state);
        if (blocked) return skipped(blocked);
        const refused = await lockedCurrencySpend('unlockBoost', ctx, (request) =>
            request(() => currencyActions.unlockBoostWithKey(ctx.challenge.id, ctx.pass.token, currencyDeps(ctx))),
        );
        if (refused) return refused;
        const member = (ctx.challenge as ActedChallenge).member;
        member.boost = { ...member.boost, state: 'AVAILABLE_KEY', timeout: null };
        return done({ spent: 'keys' });
    },

    fillExposure: async (action, ctx, state) => {
        const blocked = await spendAllowed('fillExposure', ctx, state);
        if (blocked) return skipped(blocked);
        const refused = await lockedCurrencySpend('fillExposure', ctx, (request) =>
            request(() => currencyActions.fillExposure(ctx.challenge.id, ctx.pass.token, currencyDeps(ctx))),
        );
        if (refused) return refused;
        const ranking = (ctx.challenge as ActedChallenge).member.ranking;
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
        const target = selectEntry(action.entry, ctx.challenge, selectContext(state));
        if (!target) return skipped('no entry matches');
        return done({ remember: { [action.slot]: String(target.id) } });
    },

    forget: async (action) => done({ forget: action.slot }),

    goto: async (action) => done({ goto: action.phase }),

    notify: async (action) => done({ notice: action.message }),
};

/**
 * Whether a spend that got no answer has positively taken effect on the live challenge: the boost is unlocked by a
 * key, the exposure is full, the replacement photo is entered. Anything the live state cannot show — a swap whose
 * replacement a selector chooses, a challenge that is gone — is not it. The caller re-reads live first and hands
 * over the step's blocking outcome (null when the live state is good to read on).
 */
const spendLanded = async (
    action: ScenarioAction & { type: SpendAction },
    ctx: RunnerContext,
    state: ScenarioState,
): Promise<{ landed: boolean; remember: Record<string, string> }> => {
    const none = { landed: false, remember: {} };
    const { challenge } = ctx;
    if (action.type === 'unlockBoost') {
        // Unlocked, or already applied to a photo since: either way the key was spent.
        const boost = challenge.member?.boost;
        return { ...none, landed: isKeyUnlockedBoost(boost) || boost?.state === 'USED' };
    }
    if (action.type === 'fillExposure') {
        return { ...none, landed: Number(challenge.member?.ranking?.exposure?.exposure_factor) >= 100 };
    }
    // Only a swap is left, whose replacement is known only when the step names it.
    const photo = rememberedPhoto(action.with, state);
    if (typeof photo !== 'string' || !entriesOf(challenge).some((entry) => String(entry.id) === photo)) return none;
    return { landed: true, remember: action.rememberAdded ? { [action.rememberAdded]: photo } : {} };
};

/**
 * The retry of a step whose spend got no answer. It never spends: it passes over the step when the live challenge
 * shows the spend landed, and otherwise ends the rule, since the step cannot be repeated and the steps after it
 * were meant to follow a spend that did happen.
 *
 * A re-read that cannot be trusted (a marked challenge, or a prune-unsafe read that dropped elements) is neither:
 * like the spend itself, it gave no answer — the same outcome keeps the spend in flight, counted, and the next
 * pass settles it again, never spending it.
 */
const settleUnclearSpend = async (
    action: ScenarioAction & { type: SpendAction },
    ctx: RunnerContext,
    state: ScenarioState,
    from: Retry,
): Promise<ActionOutcome> => {
    const blocked = await refreshLive(ctx);
    if (blocked?.status === 'deferred') {
        // A spend that got no answer was counted when it was marked; one recovered from its pending marker is
        // counted now, and its type stays `lost` so the card can tell that origin.
        return {
            ...noAnswer(action.type, from.count),
            ...(from.origin === 'pending' ? { origin: 'pending' as const } : {}),
        };
    }
    const { landed, remember } = blocked ? { landed: false, remember: {} } : await spendLanded(action, ctx, state);
    // A spend that got no answer was counted when it was marked; one recovered from its pending marker is counted now.
    if (landed) return done({ remember, ...(from.count ? { spent: limitOf(action.type) } : {}) });
    return unclearHalted(action.type, from);
};

export { ACTIONS, settleUnclearSpend };
