/**
 * submitBoostPinnedPhoto — the Boost-pinned submit's gone branch, driven through
 * runBoost (the same single-threaded flow resolveBoostTarget reaches when the
 * Boost pin is gone): the pending guard, the exact-photo submit, the
 * definitive/transient failure split (latch vs retry), the challenge-gone and
 * fallback logs, and the fresh-entry hold on the submitted photo. The same
 * submit run at Auto-Submit time is driven through runDeadlineActions: it takes
 * the Auto-Submit's slot when Auto-Submit is due before Boost, and the usual
 * pick runs only when the pin cannot be (or has been latched as not) submitted.
 */

jest.mock('../../src/ts/core/settings', () => ({
    getEffectiveSetting: jest.fn(() => false),
    getSetting: jest.fn(() => 'UTC'),
    getEntryPins: jest.fn(() => ({ boost: null, turbo: null })),
    consumeChosenPhotos: jest.fn(() => false),
}));

jest.mock('../../src/ts/core/services/VotingLogic', () => ({
    __esModule: true,
    ...jest.requireActual<typeof votingLogicModule>('../../src/ts/core/services/VotingLogic'),
    resolvePin: jest.fn(() => ({ state: 'none' })),
    shouldApplyBoost: jest.fn(() => false),
    isBoostDueForMission: jest.fn(() => false),
    getAutoFillThresholdSec: jest.fn(() => 0),
    isWithinEmergencyWindow: jest.fn(() => false),
}));

jest.mock('../../src/ts/core/services/autoFill', () => ({
    submitPinnedEntry: jest.fn(async () => ({ ok: false, imageId: null, reason: 'fetch-error' })),
    submitNewEntryForAction: jest.fn(async () => ({ ok: false, imageId: null, reason: 'none' })),
    reflectNewEntry: jest.fn(),
    reflectEntryFlag: jest.fn(),
    // The two reads of the autoFill facade the real canSubmitBoostPin makes.
    maybeAutoFillChallenge: jest.fn(async () => 'skipped'),
    maybeEmergencyFillChallenge: jest.fn(async () => 'skipped'),
    resolveAutoSubmitDue: jest.fn(),
    createFinalEligibility: jest.fn(),
    // Read by the real describeDeadlineActions: no emergency fill, the real schedule math.
    evaluateEmergencyFill: jest.fn(() => ({ standDown: true })),
    getNextScheduleThresholdSec: jest.fn(
        jest.requireActual<typeof import('../../src/ts/core/services/autoFill/schedule')>(
            '../../src/ts/core/services/autoFill/schedule',
        ).getNextScheduleThresholdSec,
    ),
    resolveChosenPhotos: jest.fn(({ read }: { read: (key: string) => unknown }) => {
        const list = read('chosenPhotos');
        return {
            ids: Array.isArray(list) ? list.map(String) : [],
            only: read('chosenPhotosOnly') === true,
            inOrder: read('chosenPhotosInOrder') === true,
        };
    }),
    getSlotsRemaining: jest.fn(),
}));

import logger = require('../../src/ts/core/logger');
import settingsModule = require('../../src/ts/core/settings');
const settings = jest.mocked(settingsModule);
import votingLogicModule = require('../../src/ts/core/services/VotingLogic');
const votingLogic = jest.mocked(votingLogicModule);
import autoFillModule = require('../../src/ts/core/services/autoFill');
const autoFill = jest.mocked(autoFillModule);
import type * as boostModule from '../../src/ts/core/services/votingOrchestrator/boost';
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
import type * as entryAgeStoreModule from '../../src/ts/core/entryAgeStore';
import { renderLogTemplate } from '../helpers/logTemplate';
import type { Challenge } from '../../src/ts/core/types/gurushots';
import type { ActionContext } from '../../src/ts/core/services/votingOrchestrator/context';
import { invalid } from '../helpers/invalid';
import type * as actionRunnersModule from '../../src/ts/core/services/votingOrchestrator/actionRunners';
import type { PassContext } from '../../src/ts/core/services/votingOrchestrator/context';
const { runBoost } = require('../../src/ts/core/services/votingOrchestrator/boost') as typeof boostModule;
const { runDeadlineActions } =
    require('../../src/ts/core/services/votingOrchestrator/actionRunners') as typeof actionRunnersModule;
const { buildChallenge } = require('../helpers/challengeFixtures') as typeof challengeFixturesModule;
const { createMemoryEntryAgeLedger } = require('../../src/ts/core/entryAgeStore') as typeof entryAgeStoreModule;
const { boostDeadline } =
    require('../../src/ts/core/voting/boostWindow') as typeof import('../../src/ts/core/voting/boostWindow');

const NOW = Math.floor(Date.now() / 1000);
const CLOSE = NOW + 3600;
const PIN = 'pin1';
const LATCH_DEADLINE = NOW + 900;

// The T-methods render through the real catalog onto the same level fn, so the
// assertions below keep reading today's rendered lines.
type SinkFn = jest.Mock<void, unknown[]>;
type TemplateFn = jest.Mock<void, [string, unknown[], unknown?]>;
const log: Record<'info' | 'success' | 'error' | 'debug' | 'startOperation' | 'endOperation', SinkFn> &
    Record<'infoT' | 'warningT' | 'errorT', TemplateFn> = {
    info: jest.fn<void, unknown[]>(),
    success: jest.fn<void, unknown[]>(),
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
                autoBoost: true,
                autoSubmitSchedule: [{ count: 2, seconds: 7000 }],
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

const slotsOf = (challenge: Partial<Challenge> | null | undefined) =>
    Math.max(0, (challenge?.max_photo_submits ?? 0) - (challenge?.member?.ranking?.entries?.length ?? 0));

// The Auto-Submit gate answers due, with the authorization values the final check is built from.
const DUE = invalid<ReturnType<typeof autoFillModule.resolveAutoSubmitDue>>({
    due: true,
    trigger: {
        relativeTarget: 2,
        clockTarget: 0,
        desired: 2,
        activeClockTimes: [],
        nextClockStart: null,
        timezone: 'UTC',
    },
    schedule: [{ count: 2, seconds: 7000 }],
    desired: 2,
    slotsRemaining: 2,
});
const finalCheck = async () => null;

beforeEach(() => {
    jest.clearAllMocks();
    autoFill.getSlotsRemaining.mockImplementation(slotsOf);
    autoFill.resolveAutoSubmitDue.mockReturnValue(DUE);
    autoFill.createFinalEligibility.mockReturnValue(finalCheck);
    autoFill.maybeAutoFillChallenge.mockResolvedValue('skipped');
    autoFill.reflectNewEntry.mockReset();
    jest.mocked(logger.withCategory).mockImplementation(() => invalid(log));
    enable();
    settings.getEntryPins.mockReturnValue({ boost: PIN, turbo: null });
    votingLogic.resolvePin.mockReturnValue({ state: 'gone' });
    votingLogic.shouldApplyBoost.mockReturnValue(true);
    votingLogic.isBoostDueForMission.mockReturnValue(false);
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
        expect(autoFill.submitPinnedEntry).toHaveBeenCalledWith(challenge, 'tok', ctx.fillDeps, PIN, undefined);
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

        expect(autoFill.submitPinnedEntry).toHaveBeenCalledWith(challenge, 'tok', ctx.fillDeps, PIN, undefined);
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

// ---------------------------------------------------------------------------
// The Boost-pinned submit at Auto-Submit time (runAutoFill through runDeadlineActions)
// ---------------------------------------------------------------------------

const passFor = (challenge: Challenge, entryAges: ReturnType<typeof createMemoryEntryAgeLedger> | null) =>
    invalid<PassContext>({
        token: 'tok',
        api: { applyBoost: jest.fn(), applyBoostToEntry: jest.fn() },
        fillDeps: { settings },
        entryAges,
        missions: null,
        allChallenges: [challenge],
    });

/** Two entries in a three-slot challenge: exactly one free slot. */
const oneSlotChallenge = () => {
    const challenge = goneChallenge();
    challenge.member!.ranking!.entries = [{ id: 'e1' }, { id: 'e2' }];
    return challenge;
};

const failWith = (reason: string) =>
    autoFill.submitPinnedEntry.mockResolvedValue(invalid({ ok: false, imageId: null, reason }));

describe('runAutoFill — the Boost-pinned submit at Auto-Submit time', () => {
    beforeEach(() => {
        // Only the Auto-Submit runner acts in these tests; a due Boost is covered below.
        votingLogic.shouldApplyBoost.mockReturnValue(false);
    });

    test('Auto-Submit due before Boost submits the pinned photo, skips the usual pick, and logs the success once', async () => {
        const challenge = goneChallenge();
        const ledger = createMemoryEntryAgeLedger();
        const pass = passFor(challenge, ledger);

        await runDeadlineActions(challenge, NOW, pass);

        expect(autoFill.createFinalEligibility).toHaveBeenCalledWith(challenge, '101', 'tok', pass.fillDeps, {
            trigger: DUE.due ? DUE.trigger : null,
            authorizer: 'relative',
            schedule: [{ count: 2, seconds: 7000 }],
            desired: 2,
            slotsRemaining: 2,
        });
        expect(autoFill.submitPinnedEntry).toHaveBeenCalledTimes(1);
        expect(autoFill.submitPinnedEntry).toHaveBeenCalledWith(challenge, 'tok', pass.fillDeps, PIN, finalCheck);
        expect(autoFill.reflectNewEntry).toHaveBeenCalledWith(challenge, PIN);
        expect(ledger.pending('101')).toBe(PIN);
        expect(autoFill.maybeAutoFillChallenge).not.toHaveBeenCalled();
        expect(log.success).toHaveBeenCalledTimes(1);
        expect(log.success).toHaveBeenCalledWith(
            expect.stringContaining('autoSubmit: submitted the photo pinned for Boost (pin1) for'),
            null,
        );
    });

    test('a pending submit of the pin is held: no submit, no usual pick, no success log', async () => {
        const challenge = goneChallenge();
        const ledger = createMemoryEntryAgeLedger();
        ledger.markPending(challenge, PIN, NOW - 60);

        await runDeadlineActions(challenge, NOW, passFor(challenge, ledger));

        expect(autoFill.submitPinnedEntry).not.toHaveBeenCalled();
        expect(autoFill.maybeAutoFillChallenge).not.toHaveBeenCalled();
        expect(log.success).not.toHaveBeenCalled();
    });

    test('a definitive failure latches and the usual pick runs in the same call', async () => {
        const challenge = goneChallenge();
        const ledger = createMemoryEntryAgeLedger();
        failWith('submit-rejected');

        await runDeadlineActions(challenge, NOW, passFor(challenge, ledger));

        expect(ledger.pinSubmitFailed('101', PIN, boostDeadline(challenge))).toBe(true);
        expect(autoFill.submitPinnedEntry).toHaveBeenCalledTimes(1);
        expect(autoFill.maybeAutoFillChallenge).toHaveBeenCalledTimes(1);
        expect(log.success).not.toHaveBeenCalled();
    });

    test.each([['fetch-error'], ['challenge-gone']])(
        'a %s failure with one free slot keeps the slot: no usual pick, no latch',
        async (reason) => {
            const challenge = oneSlotChallenge();
            const ledger = createMemoryEntryAgeLedger();
            failWith(reason);

            await runDeadlineActions(challenge, NOW, passFor(challenge, ledger));

            expect(autoFill.submitPinnedEntry).toHaveBeenCalledTimes(1);
            expect(autoFill.maybeAutoFillChallenge).not.toHaveBeenCalled();
            expect(ledger.pinSubmitFailed('101', PIN, boostDeadline(challenge))).toBe(false);
        },
    );

    test.each([['fetch-error'], ['challenge-gone']])(
        'a %s failure with two free slots runs the usual pick in the same call',
        async (reason) => {
            const challenge = goneChallenge();
            const ledger = createMemoryEntryAgeLedger();
            failWith(reason);

            await runDeadlineActions(challenge, NOW, passFor(challenge, ledger));

            expect(autoFill.submitPinnedEntry).toHaveBeenCalledTimes(1);
            expect(autoFill.maybeAutoFillChallenge).toHaveBeenCalledTimes(1);
        },
    );

    test('the final check standing down (reported as no-slots) submits nothing, latches nothing, and keeps the last slot', async () => {
        const challenge = oneSlotChallenge();
        const ledger = createMemoryEntryAgeLedger();
        failWith('no-slots');

        await runDeadlineActions(challenge, NOW, passFor(challenge, ledger));

        expect(autoFill.reflectNewEntry).not.toHaveBeenCalled();
        expect(ledger.pending('101')).toBeNull();
        expect(ledger.pinSubmitFailed('101', PIN, boostDeadline(challenge))).toBe(false);
        expect(autoFill.maybeAutoFillChallenge).not.toHaveBeenCalled();
        expect(log.success).not.toHaveBeenCalled();
    });

    test('Auto-Submit not due: it runs as usual and the pinned submit waits for Boost time, with no final check', async () => {
        votingLogic.shouldApplyBoost.mockReturnValue(true);
        autoFill.resolveAutoSubmitDue.mockReturnValue({ due: false, status: 'skipped' });
        const challenge = goneChallenge();
        const ledger = createMemoryEntryAgeLedger();
        const pass = passFor(challenge, ledger);

        await runDeadlineActions(challenge, NOW, pass);

        expect(autoFill.maybeAutoFillChallenge).toHaveBeenCalledTimes(1);
        expect(autoFill.createFinalEligibility).not.toHaveBeenCalled();
        expect(autoFill.submitPinnedEntry).toHaveBeenCalledTimes(1);
        expect(autoFill.submitPinnedEntry).toHaveBeenCalledWith(challenge, 'tok', pass.fillDeps, PIN, undefined);
        expect(log.success).not.toHaveBeenCalled();
    });

    test('Auto Boost off: the pinned submit is not promised, so the usual pick runs', async () => {
        enable({ autoBoost: false });
        const challenge = goneChallenge();

        await runDeadlineActions(challenge, NOW, passFor(challenge, createMemoryEntryAgeLedger()));

        expect(autoFill.submitPinnedEntry).not.toHaveBeenCalled();
        expect(autoFill.maybeAutoFillChallenge).toHaveBeenCalledTimes(1);
    });

    describe('both due in one pass', () => {
        beforeEach(() => {
            votingLogic.shouldApplyBoost.mockReturnValue(true);
            // The entry the submit adds is visible to the Boost that runs after it.
            autoFill.reflectNewEntry.mockImplementation((challenge, imageId) => {
                challenge?.member?.ranking?.entries?.push({ id: String(imageId) });
            });
        });

        const expectSubmittedOnceAndBoostOnIt = (challenge: Challenge) => {
            expect(autoFill.submitPinnedEntry).toHaveBeenCalledTimes(1);
            expect(autoFill.submitPinnedEntry).toHaveBeenCalledWith(
                challenge,
                'tok',
                expect.anything(),
                PIN,
                finalCheck,
            );
            expect(autoFill.maybeAutoFillChallenge).not.toHaveBeenCalled();
            expect(log.success).toHaveBeenCalledTimes(1);
            // Boost found the live pin and holds on it for the fresh-photo wait.
            expect(challenge.boostHoldUntil).toBe(NOW + 600);
        };

        test('with a relative schedule: Auto-Submit runs first and submits the pin; Boost goes on it', async () => {
            const challenge = goneChallenge();

            await runDeadlineActions(challenge, NOW, passFor(challenge, createMemoryEntryAgeLedger()));

            expectSubmittedOnceAndBoostOnIt(challenge);
        });

        test('with an active clock window: Auto-Submit sorts first even below the Boost threshold', async () => {
            const clock = new Date(NOW * 1000).toISOString().slice(11, 16);
            enable({
                autoSubmitSchedule: [{ count: 2, seconds: 100 }],
                autoSubmitTime: [clock],
                autoSubmitWindowMinutes: 30,
            });
            const challenge = goneChallenge();

            await runDeadlineActions(challenge, NOW, passFor(challenge, createMemoryEntryAgeLedger()));

            expectSubmittedOnceAndBoostOnIt(challenge);
        });
    });
});
