/**
 * submitBoostPinnedPhoto — the Boost-pinned submit's gone branch, driven through
 * runBoost (the same single-threaded flow resolveBoostTarget reaches when the
 * Boost pin is gone): the pending guard, the exact-photo submit, the
 * definitive/transient failure split (latch vs retry), the challenge-gone and
 * fallback logs, and the fresh-entry hold on the submitted photo.
 */

jest.mock('../../src/ts/settings', () => ({
    getEffectiveSetting: jest.fn(() => false),
    getEntryPins: jest.fn(() => ({ boost: null, turbo: null })),
    consumeChosenPhotos: jest.fn(() => false),
}));

jest.mock('../../src/ts/services/VotingLogic', () => ({
    __esModule: true,
    ...jest.requireActual<typeof votingLogicModule>('../../src/ts/services/VotingLogic'),
    resolvePin: jest.fn(() => ({ state: 'none' })),
    shouldApplyBoost: jest.fn(() => false),
    isBoostDueForMission: jest.fn(() => false),
    getAutoFillThresholdSec: jest.fn(() => 0),
    isWithinEmergencyWindow: jest.fn(() => false),
}));

jest.mock('../../src/ts/services/autoFill', () => ({
    submitPinnedEntry: jest.fn(async () => ({ ok: false, imageId: null, reason: 'fetch-error' })),
    submitNewEntryForAction: jest.fn(async () => ({ ok: false, imageId: null, reason: 'none' })),
    reflectNewEntry: jest.fn(),
    reflectEntryFlag: jest.fn(),
    // The two reads of the autoFill facade the real canSubmitBoostPin makes.
    resolveChosenPhotos: jest.fn(({ read }: { read: (key: string) => unknown }) => {
        const list = read('chosenPhotos');
        return {
            ids: Array.isArray(list) ? list.map(String) : [],
            only: read('chosenPhotosOnly') === true,
            inOrder: read('chosenPhotosInOrder') === true,
        };
    }),
    getSlotsRemaining: jest.fn(
        (challenge: { max_photo_submits?: number; member?: { ranking?: { entries?: unknown[] } } }) =>
            Math.max(0, (challenge?.max_photo_submits ?? 0) - (challenge?.member?.ranking?.entries?.length ?? 0)),
    ),
}));

import logger = require('../../src/ts/logger');
import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import votingLogicModule = require('../../src/ts/services/VotingLogic');
const votingLogic = jest.mocked(votingLogicModule);
import autoFillModule = require('../../src/ts/services/autoFill');
const autoFill = jest.mocked(autoFillModule);
import type * as boostModule from '../../src/ts/services/votingOrchestrator/boost';
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
import type * as entryAgeStoreModule from '../../src/ts/entryAgeStore';
import { renderLogTemplate } from '../helpers/logTemplate';
import type { Challenge } from '../../src/ts/types/gurushots';
import type { ActionContext } from '../../src/ts/services/votingOrchestrator/context';
import { invalid } from '../helpers/invalid';
const { runBoost } = require('../../src/ts/services/votingOrchestrator/boost') as typeof boostModule;
const { buildChallenge } = require('../helpers/challengeFixtures') as typeof challengeFixturesModule;
const { createMemoryEntryAgeLedger } = require('../../src/ts/entryAgeStore') as typeof entryAgeStoreModule;
const { boostDeadline } =
    require('../../src/ts/voting/boostWindow') as typeof import('../../src/ts/voting/boostWindow');

const NOW = Math.floor(Date.now() / 1000);
const CLOSE = NOW + 3600;
const PIN = 'pin1';
const LATCH_DEADLINE = NOW + 900;

// The T-methods render through the real catalog onto the same level fn, so the
// assertions below keep reading today's rendered lines.
type SinkFn = jest.Mock<void, unknown[]>;
type TemplateFn = jest.Mock<void, [string, unknown[], unknown?]>;
const log: Record<'info' | 'error' | 'debug' | 'startOperation' | 'endOperation', SinkFn> &
    Record<'infoT' | 'warningT' | 'errorT', TemplateFn> = {
    info: jest.fn<void, unknown[]>(),
    error: jest.fn<void, unknown[]>(),
    debug: jest.fn<void, unknown[]>(),
    startOperation: jest.fn<void, unknown[]>(),
    endOperation: jest.fn<void, unknown[]>(),
    infoT: jest.fn<void, [string, unknown[], unknown?]>((key, params, data) =>
        log.info(renderLogTemplate(key, params), data),
    ),
    warningT: jest.fn<void, [string, unknown[], unknown?]>((key, params, data) =>
        log.info(renderLogTemplate(key, params), data),
    ),
    errorT: jest.fn<void, [string, unknown[], unknown?]>((key, params, data) =>
        log.error(renderLogTemplate(key, params), data),
    ),
};
const infoTKeys = () => log.infoT.mock.calls.map(([key]) => key);

// A challenge whose Boost pin has left it: one entry left, a timer boost due now.
const goneChallenge = () =>
    buildChallenge({
        id: 101,
        title: 'Pinned',
        close_time: CLOSE,
        max_photo_submits: 3,
        member: {
            boost: { state: 'AVAILABLE', timeout: LATCH_DEADLINE },
            ranking: { entries: [{ id: 'e1' }], exposure: { exposure_factor: 50 } },
        },
    });

/** The settings read: the opt-in and the fresh-entry wait on, the pinned photo chosen, Auto-Submit on. */
const enable = (values: Record<string, unknown> = {}) =>
    settings.getEffectiveSetting.mockImplementation(
        (key) =>
            ({
                boostPinnedSubmit: true,
                boostFreshEntryWait: 600,
                autoSubmit: true,
                chosenPhotos: [PIN],
                boostTime: 3600,
                keyUnlockedBoostTime: 900,
                ...values,
            })[key],
    );

interface CtxBundle {
    ctx: ActionContext;
    api: { applyBoost: SinkFn; applyBoostToEntry: SinkFn };
}

const bundle = (challenge: Challenge, entryAges: ReturnType<typeof createMemoryEntryAgeLedger> | null): CtxBundle => {
    const api = { applyBoost: jest.fn(), applyBoostToEntry: jest.fn() };
    const ctx = invalid<ActionContext>({
        challenge,
        token: 'tok',
        now: NOW,
        api,
        fillDeps: { settings },
        entryAges,
    });
    return { ctx, api };
};

const runBoostWith = async ({ ctx }: { ctx: ActionContext }) => runBoost(ctx);

beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(logger.withCategory).mockImplementation(() => invalid(log));
    enable();
    settings.getEntryPins.mockReturnValue({ boost: PIN, turbo: null });
    votingLogic.resolvePin.mockReturnValue({ state: 'gone' });
    votingLogic.shouldApplyBoost.mockReturnValue(true);
    votingLogic.getAutoFillThresholdSec.mockReturnValue(900);
    votingLogic.isWithinEmergencyWindow.mockReturnValue(false);
    autoFill.submitPinnedEntry.mockResolvedValue(invalid({ ok: true, imageId: PIN, reason: 'submitted' }));
});

describe('submitBoostPinnedPhoto through runBoost — success', () => {
    test('submits exactly the pinned id, reflects it, marks it pending, and holds for the fresh-entry wait', async () => {
        const challenge = goneChallenge();
        const ledger = createMemoryEntryAgeLedger();
        const { ctx, api } = bundle(challenge, ledger);

        await runBoostWith({ ctx });

        expect(autoFill.submitPinnedEntry).toHaveBeenCalledTimes(1);
        expect(autoFill.submitPinnedEntry).toHaveBeenCalledWith(challenge, 'tok', ctx.fillDeps, PIN);
        expect(autoFill.reflectNewEntry).toHaveBeenCalledWith(challenge, PIN);
        expect(ledger.pending('101')).toBe(PIN);
        // The pinned target is never skipped as uncertain, and the fresh-photo wait holds the boost.
        expect(challenge.boostHoldUntil).toBe(NOW + 600);
        expect(api.applyBoost).not.toHaveBeenCalled();
        expect(api.applyBoostToEntry).not.toHaveBeenCalled();
    });

    test('runs the same when the boost is due through the mission pull-forward, not the clock', async () => {
        votingLogic.shouldApplyBoost.mockReturnValue(false);
        votingLogic.isBoostDueForMission.mockReturnValue(true);
        const challenge = goneChallenge();
        const ledger = createMemoryEntryAgeLedger();
        const { ctx } = bundle(challenge, ledger);

        await runBoostWith({ ctx });

        expect(autoFill.submitPinnedEntry).toHaveBeenCalledWith(challenge, 'tok', ctx.fillDeps, PIN);
        expect(ledger.pending('101')).toBe(PIN);
    });

    test('a different photo pending: the pinned photo is submitted and replaces it as pending', async () => {
        const challenge = goneChallenge();
        const ledger = createMemoryEntryAgeLedger();
        ledger.markPending(challenge, 'other', NOW - 60);
        const { ctx } = bundle(challenge, ledger);

        await runBoostWith({ ctx });

        expect(autoFill.submitPinnedEntry).toHaveBeenCalledTimes(1);
        expect(ledger.pending('101')).toBe(PIN);
    });
});

describe('submitBoostPinnedPhoto through runBoost — the pending guard', () => {
    test.each([[true], [false]])(
        'a pending photo equal to the pin is held without a second submit (setting %s)',
        async (settingOn) => {
            const challenge = goneChallenge();
            const ledger = createMemoryEntryAgeLedger();
            ledger.markPending(challenge, PIN, NOW - 60);
            const { ctx, api } = bundle(challenge, ledger);
            enable({ boostPinnedSubmit: settingOn });

            await runBoostWith({ ctx });

            expect(autoFill.submitPinnedEntry).not.toHaveBeenCalled();
            // The held submit rides out the fresh-entry wait like any pinned target.
            expect(challenge.boostHoldUntil).toBe(NOW + 540);
            expect(api.applyBoostToEntry).not.toHaveBeenCalled();
        },
    );
});

describe('submitBoostPinnedPhoto through runBoost — definitive failures latch', () => {
    test.each([['submit-rejected'], ['pin-refused'], ['pin-not-found'], ['pin-unreachable'], ['pin-filtered']])(
        '%s: latch set, wait armed, a second due pass makes no fetch/submit call',
        async (reason) => {
            const challenge = goneChallenge();
            const ledger = createMemoryEntryAgeLedger();
            const { ctx, api } = bundle(challenge, ledger);
            autoFill.submitPinnedEntry.mockResolvedValue(invalid({ ok: false, imageId: null, reason }));

            await runBoostWith({ ctx });

            expect(ledger.pinSubmitFailed('101', PIN, boostDeadline(challenge))).toBe(true);
            expect(log.infoT).toHaveBeenCalledWith('mb0d7e3a91c65', ['[Challenge 101: Pinned]', PIN, reason], null);
            // The wake lands one last poll before the boost dies, mirroring the pin-wait clamp.
            expect(challenge.boostHoldUntil).toBe(boostDeadline(challenge) - 60);
            expect(api.applyBoostToEntry).not.toHaveBeenCalled();

            await runBoostWith({ ctx });

            expect(autoFill.submitPinnedEntry).toHaveBeenCalledTimes(1);
            expect(infoTKeys().filter((key) => key === 'm3e7a92c4b518')).toHaveLength(1);
        },
    );
});

describe('submitBoostPinnedPhoto through runBoost — transient failures retry', () => {
    test('submit-unanswered retries once, then a server refusal on the next pass latches', async () => {
        const challenge = goneChallenge();
        const ledger = createMemoryEntryAgeLedger();
        const { ctx } = bundle(challenge, ledger);
        autoFill.submitPinnedEntry
            .mockResolvedValueOnce(invalid({ ok: false, imageId: null, reason: 'submit-unanswered' }))
            .mockResolvedValueOnce(invalid({ ok: false, imageId: null, reason: 'submit-rejected' }));

        await runBoostWith({ ctx });

        // The no-answer pass latches nothing and arms the wake.
        expect(ledger.pinSubmitFailed('101', PIN, boostDeadline(challenge))).toBe(false);
        expect(log.infoT).toHaveBeenCalledWith(
            'mb2f6a1d84b09',
            ['[Challenge 101: Pinned]', PIN, 'submit-unanswered'],
            null,
        );
        expect(challenge.boostHoldUntil).toBe(boostDeadline(challenge) - 60);

        await runBoostWith({ ctx });

        // The next pass's refusal is definitive: latched, no third attempt.
        expect(ledger.pinSubmitFailed('101', PIN, boostDeadline(challenge))).toBe(true);
        expect(log.infoT).toHaveBeenCalledWith(
            'mb0d7e3a91c65',
            ['[Challenge 101: Pinned]', PIN, 'submit-rejected'],
            null,
        );
        expect(autoFill.submitPinnedEntry).toHaveBeenCalledTimes(2);
    });

    test('walk-incomplete retries once, then a completed walk that misses the pin latches', async () => {
        const challenge = goneChallenge();
        const ledger = createMemoryEntryAgeLedger();
        const { ctx } = bundle(challenge, ledger);
        autoFill.submitPinnedEntry
            .mockResolvedValueOnce(invalid({ ok: false, imageId: null, reason: 'walk-incomplete' }))
            .mockResolvedValueOnce(invalid({ ok: false, imageId: null, reason: 'pin-not-found' }));

        await runBoostWith({ ctx });

        expect(ledger.pinSubmitFailed('101', PIN, boostDeadline(challenge))).toBe(false);
        expect(log.infoT).toHaveBeenCalledWith(
            'mb2f6a1d84b09',
            ['[Challenge 101: Pinned]', PIN, 'walk-incomplete'],
            null,
        );
        expect(challenge.boostHoldUntil).toBe(boostDeadline(challenge) - 60);

        await runBoostWith({ ctx });

        expect(ledger.pinSubmitFailed('101', PIN, boostDeadline(challenge))).toBe(true);
        expect(log.infoT).toHaveBeenCalledWith(
            'mb0d7e3a91c65',
            ['[Challenge 101: Pinned]', PIN, 'pin-not-found'],
            null,
        );
        expect(autoFill.submitPinnedEntry).toHaveBeenCalledTimes(2);
    });

    test.each([['fetch-error'], ['data-incomplete'], ['no-slots'], ['invalid-challenge']])(
        '%s: no latch, the next due pass tries again',
        async (reason) => {
            const challenge = goneChallenge();
            const ledger = createMemoryEntryAgeLedger();
            const { ctx } = bundle(challenge, ledger);
            autoFill.submitPinnedEntry.mockResolvedValue(invalid({ ok: false, imageId: null, reason }));

            await runBoostWith({ ctx });

            expect(ledger.pinSubmitFailed('101', PIN, boostDeadline(challenge))).toBe(false);
            expect(log.infoT).toHaveBeenCalledWith('mb2f6a1d84b09', ['[Challenge 101: Pinned]', PIN, reason], null);
            expect(challenge.boostHoldUntil).toBe(boostDeadline(challenge) - 60);

            await runBoostWith({ ctx });

            expect(autoFill.submitPinnedEntry).toHaveBeenCalledTimes(2);
        },
    );
});

describe('submitBoostPinnedPhoto through runBoost — skips and fallbacks', () => {
    test('challenge-gone logs the active-list key and skips without arming a wake', async () => {
        const challenge = goneChallenge();
        const ledger = createMemoryEntryAgeLedger();
        const { ctx } = bundle(challenge, ledger);
        autoFill.submitPinnedEntry.mockResolvedValue(invalid({ ok: false, imageId: null, reason: 'challenge-gone' }));

        await runBoostWith({ ctx });

        expect(log.infoT).toHaveBeenCalledWith('m68af6d2b3623', ['[Challenge 101: Pinned]'], null);
        expect(ledger.pinSubmitFailed('101', PIN, boostDeadline(challenge))).toBe(false);
        expect(challenge.boostHoldUntil).toBeUndefined();
    });

    test.each([
        ['the setting is off', () => enable({ boostPinnedSubmit: false })],
        ['Manual Only is on', () => enable({ manualPhotosOnly: true })],
        ['the pin is not a chosen photo', () => enable({ chosenPhotos: ['other'] })],
        ['every slot is taken', () => autoFill.getSlotsRemaining.mockReturnValue(0)],
        ['the pin names no photo', () => settings.getEntryPins.mockReturnValue({ boost: null, turbo: null })],
    ])('fallback to the plain wait when %s', async (_label, arrange) => {
        const challenge = goneChallenge();
        const ledger = createMemoryEntryAgeLedger();
        const { ctx, api } = bundle(challenge, ledger);
        arrange();

        await runBoostWith({ ctx });

        expect(autoFill.submitPinnedEntry).not.toHaveBeenCalled();
        expect(infoTKeys()).toContain('m3e7a92c4b518');
        expect(challenge.boostHoldUntil).toBe(boostDeadline(challenge) - 60);
        expect(api.applyBoostToEntry).not.toHaveBeenCalled();
    });

    test('without an entry-age ledger the latch cannot be honoured, so the plain wait stands', async () => {
        const challenge = goneChallenge();
        const { ctx, api } = bundle(challenge, null);

        await runBoostWith({ ctx });

        expect(autoFill.submitPinnedEntry).not.toHaveBeenCalled();
        expect(infoTKeys()).toContain('m3e7a92c4b518');
        expect(api.applyBoostToEntry).not.toHaveBeenCalled();
    });
});
