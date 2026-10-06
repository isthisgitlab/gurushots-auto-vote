/**
 * The scenario action handlers.
 *
 * Contract: see the runner contract in the scenarioRunner.ts header (live re-read
 * before each action, persist after each, unreadable state halts).
 */

import * as currencyActions from '../currencyActions';
import { submitNewEntryForAction, reflectNewEntry, reflectEntryFlag, getSlotsRemaining } from '../autoFill';
import { selectEntry, entriesOf } from '../../scenarios/selectors';
import type { ActedChallenge, ActionHandler, ActionType, ScenarioAction, SwapPhoto } from './types';
import {
    BOOST_APPLICABLE,
    currencyDeps,
    done,
    failed,
    lockedCurrencySpend,
    refreshLive,
    rememberedPhoto,
    selectContext,
    skipped,
    spendAllowed,
} from './support';

const ACTIONS: { [K in ActionType]: ActionHandler<Extract<ScenarioAction, { type: K }>> } = {
    enterPhoto: async (action, ctx, state) => {
        const { challenge, pass } = ctx;
        const photoId = rememberedPhoto(action.photo, state);
        if (photoId === undefined)
            return skipped(`memory slot "${(action.photo as { memory: string }).memory}" is empty`);
        let enteredId = photoId;
        if (photoId === null) {
            // The fill path re-reads the challenge live and checks the free slots itself.
            const filled = await submitNewEntryForAction(challenge, pass.token, pass.fillDeps);
            if (filled.reason === 'no-slots') return skipped('no free entry slot');
            if (filled.reason === 'challenge-gone') return skipped('the challenge is no longer active');
            if (filled.reason === 'no-eligible') return skipped('no eligible photo to enter');
            if (filled.reason === 'no-chosen') return skipped('no chosen photo can be entered');
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
        // Both paths above leave a photo id here.
        const entered = enteredId as string;
        return done({ remember: action.remember ? { [action.remember]: entered } : {} });
    },

    swap: async (action, ctx, state) => {
        const { challenge, pass } = ctx;
        const newPhoto = rememberedPhoto(action.with, state);
        if (newPhoto === undefined)
            return skipped(`memory slot "${(action.with as { memory: string }).memory}" is empty`);
        if (!(await refreshLive(ctx))) return skipped('the challenge is no longer active');
        const target = selectEntry(action.entry, challenge, selectContext(state));
        if (!target) return skipped('no entry matches the swap target');
        if (newPhoto !== null && entriesOf(challenge).some((entry) => String(entry.id) === newPhoto)) {
            return skipped(`photo ${newPhoto} is already entered`);
        }
        const blocked = await spendAllowed('swap', ctx, state);
        if (blocked) return skipped(blocked);

        let replacement: SwapPhoto | null =
            newPhoto === null ? null : { id: newPhoto, member_id: String(target.member_id ?? '') };
        const refused = await lockedCurrencySpend('swap', ctx, async () => {
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
            return currencyActions.swapEntry(challenge.id, target.id, replacement.id, pass.token, {
                ...currencyDeps(ctx),
                ledger: pass.currency.swapLedger ?? null,
            });
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
        if (!(await refreshLive(ctx))) return skipped('the challenge is no longer active');
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
        if (!(await refreshLive(ctx))) return skipped('the challenge is no longer active');
        if (challenge.member?.turbo?.state !== 'WON') {
            return skipped(`no won turbo to apply (${challenge.member?.turbo?.state ?? 'unknown'})`);
        }
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
        const refused = await lockedCurrencySpend('unlockBoost', ctx, () =>
            currencyActions.unlockBoostWithKey(ctx.challenge.id, ctx.pass.token, currencyDeps(ctx)),
        );
        if (refused) return refused;
        const member = (ctx.challenge as ActedChallenge).member;
        member.boost = { ...member.boost, state: 'AVAILABLE_KEY', timeout: null };
        return done({ spent: 'keys' });
    },

    fillExposure: async (action, ctx, state) => {
        const blocked = await spendAllowed('fillExposure', ctx, state);
        if (blocked) return skipped(blocked);
        const refused = await lockedCurrencySpend('fillExposure', ctx, () =>
            currencyActions.fillExposure(ctx.challenge.id, ctx.pass.token, currencyDeps(ctx)),
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

export { ACTIONS };
