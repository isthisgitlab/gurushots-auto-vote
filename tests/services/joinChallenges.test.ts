/**
 * Tests for services/joinChallenges.ts — the paid-spend safety model:
 * photo-first ordering, unlock/submit idempotency, the double-spend lock,
 * budget accounting, cancellation, and the null-bankroll fail-safe.
 */

jest.mock('../../src/ts/logger', () => {
    const level = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        withCategory: jest.fn(() => level),
        challengeTag: (c: { id?: string | number } | null) => `challenge ${c?.id}`,
    };
});
jest.mock('../../src/ts/voting/cancellation', () => ({ isCancelled: jest.fn(() => false) }));
jest.mock('../../src/ts/services/autoFill', () => ({
    // The join's chosen-photos helpers are reached through this facade; they are the real ones.
    ...jest.requireActual<typeof import('../../src/ts/services/autoFill/chosenPhotos')>(
        '../../src/ts/services/autoFill/chosenPhotos',
    ),
    fetchCandidatesForChallenge: jest.fn(async () => [{ id: 'imgA', permission: { allowed: true } }]),
    resolveSemanticScores: jest.fn(async () => null),
}));
jest.mock('../../src/ts/services/photoPicker', () => ({
    pickPhotosForChallenge: jest.fn(() => ['imgA']),
}));
jest.mock('../../src/ts/services/visionVerifier', () => ({
    rankVisually: jest.fn(async (challenge: unknown, ids: string[], eligible: unknown, wantCount: number) =>
        ids.slice(0, wantCount),
    ),
}));
jest.mock('../../src/ts/settings', () => ({
    getEffectiveSetting: jest.fn((key: string) => {
        const map: Record<string, unknown> = {
            autoJoin: true,
            autoJoinTypes: '',
            autoJoinMaxCoins: 150,
            autoJoinCycleCoinBudget: 300,
            fillWithoutTagMatch: true,
        };
        return map[key];
    }),
    getEffectiveTagSetting: jest.fn(() => []),
    getTitleRules: jest.fn(() => []),
    getChallengeProfiles: jest.fn(() => ({})),
    resolveRuleSetting: jest.fn(() => null),
    hasRuleJoinOptIn: jest.fn(() => false),
}));

import cancellationModule = require('../../src/ts/voting/cancellation');
const cancellation = jest.mocked(cancellationModule);
import photoPickerModule = require('../../src/ts/services/photoPicker');
const photoPicker = jest.mocked(photoPickerModule);
import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import type * as joinChallengesModule from '../../src/ts/services/joinChallenges';
import type * as memberIdentityModule from '../../src/ts/services/autoFill/memberIdentity';
import type * as autoFillModule from '../../src/ts/services/autoFill';
import type { Challenge } from '../../src/ts/types/gurushots';
import type { RawJsonStore } from '../../src/ts/types/stores';
import type { RuleMatchChallenge } from '../../src/ts/types/settings';
import { invalid } from '../helpers/invalid';
import { isPlainObject } from '../../src/ts/plainObject';
import { findClaim, markUnlocked } from '../../src/ts/services/joinChallenges/unlockMarker';
import type { JoinDeps } from '../../src/ts/services/joinChallenges';
const {
    performJoin,
    runJoinPass,
    joinChallengeSingle,
    forgetUnconfirmedPayment,
    resolveJoinSetting,
    isAutoJoinActive,
    inFlight,
} = require('../../src/ts/services/joinChallenges') as typeof joinChallengesModule;

// The logger factory above: withCategory() hands back one shared level object.
// The join-state file readUnlockedState parses: one unlock marker per challenge id.
type UnlockMarkers = Record<string, { unlockedAt: number }>;
type LogMock = jest.Mock<void, [message: string, data?: unknown]>;
type LoggerMock = { withCategory: () => Record<'info' | 'error' | 'debug' | 'success' | 'warning', LogMock> };

// The facade's rule readers take a CHALLENGE (so a rule keyed on tags, type,
// photo count or runtime can match on the candidate itself).
const titleOf = (target: { title?: unknown } | null | undefined) => target?.title;

// The facade resolves a key through the matching rules (list order, inline
// before profile). Tests describe what the rules contribute for a candidate as
// a plain map; this stands in for that cascade.
const rulesGive = (valuesFor: (target: Challenge) => Record<string, unknown>) =>
    settings.resolveRuleSetting.mockImplementation((key, target) => {
        const values = valuesFor(invalid(target)) || {};
        return Object.prototype.hasOwnProperty.call(values, key) ? { value: values[key] } : null;
    });

// A claim made just now: far from any age at which claims are pruned.
const RECENT = Date.now();

// A joinState file kept in memory, as the file store would, so what is written can be read back.
const fileWith = (initial: Record<string, unknown>) => {
    let raw: string | null = JSON.stringify(initial);
    const writeRaw = jest.fn((data: string) => {
        raw = data;
    });
    const read = (): Record<string, unknown> => {
        const parsed: unknown = JSON.parse(raw ?? '{}');
        return isPlainObject(parsed) ? parsed : {};
    };
    return { readRaw: () => raw, writeRaw, read };
};

const makeStore = () => {
    let s: string | null = null;
    return { readRaw: () => s, writeRaw: (d: string) => (s = d) };
};
type Endpoint<K extends keyof JoinDeps> = Extract<NonNullable<JoinDeps[K]>, (...args: never[]) => unknown>;
const double = <K extends keyof JoinDeps>(impl: (...args: Parameters<Endpoint<K>>) => unknown) =>
    jest.fn<ReturnType<Endpoint<K>>, Parameters<Endpoint<K>>>((...args) => invalid(impl(...args)));
// Doubles of the reads most tests drive: the rows and balances carry only the fields a test reads.
const openList = (rows: unknown[]) => double<'getMemberChallenges'>(async () => rows);
const balance = (value: unknown) => double<'getBankroll'>(async () => value);
// Partial doubles: the overrides stand in for whichever endpoints a test drives.
const makeDeps = (over: Partial<JoinDeps> = {}) =>
    invalid<JoinDeps & { joinStateStore: RawJsonStore }>({
        getMemberChallenges: openList([]),
        getBankroll: balance({ coins: 1000 }),
        coinsUnlock: double<'coinsUnlock'>(async () => ({ ok: true })),
        submitToChallenge: double<'submitToChallenge'>(async () => ({ ok: true })),
        getEligiblePhotos: jest.fn(),
        getImageData: jest.fn(),
        joinStateStore: makeStore(),
        ...over,
    });

const DEFAULT_SETTINGS: Record<string, unknown> = {
    autoJoin: true,
    autoJoinTypes: '',
    autoJoinMaxCoins: 150,
    autoJoinCycleCoinBudget: 300,
    fillWithoutTagMatch: true,
};

beforeEach(() => {
    jest.clearAllMocks();
    cancellation.isCancelled.mockReturnValue(false);
    photoPicker.pickPhotosForChallenge.mockReturnValue(['imgA']);
    // Reset settings mocks to defaults so per-test overrides never leak.
    settings.getEffectiveTagSetting.mockReturnValue([]);
    settings.getTitleRules.mockReturnValue([]);
    settings.getChallengeProfiles.mockReturnValue({});
    settings.resolveRuleSetting.mockReturnValue(null);
    settings.hasRuleJoinOptIn.mockReturnValue(false);
    settings.getEffectiveSetting.mockImplementation((key) => DEFAULT_SETTINGS[key]);
    inFlight.clear();
});

describe('performJoin — ordering & idempotency', () => {
    test('free join submits, never unlocks', async () => {
        const deps = makeDeps();
        const res = await performJoin(invalid({ id: 1 }), 'tok', deps, 0);
        expect(res.status).toBe('joined');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
        expect(deps.submitToChallenge).toHaveBeenCalledWith(1, ['imgA'], 'tok');
    });

    test('joins with the visually re-ranked photo from a 12-photo shortlist', async () => {
        photoPicker.pickPhotosForChallenge.mockReturnValue(['imgA', 'imgB']);
        const rankVisually = jest.fn(async () => ['imgB']);
        const challenge = { id: 3, title: 'Glorious Green Leaves' };
        const deps = makeDeps({ rankVisually });
        const res = await performJoin(invalid(challenge), 'tok', deps, 0);
        expect(res.status).toBe('joined');
        expect(photoPicker.pickPhotosForChallenge).toHaveBeenCalledWith(
            challenge,
            expect.any(Array),
            12,
            expect.any(Object),
        );
        expect(rankVisually).toHaveBeenCalledWith(challenge, ['imgA', 'imgB'], expect.any(Array), 1, {
            logger: expect.any(Object),
            ignoreWords: null,
        });
        expect(deps.submitToChallenge).toHaveBeenCalledWith(3, ['imgB'], 'tok');
    });

    test('no eligible photo → skip, NO coins spent', async () => {
        photoPicker.pickPhotosForChallenge.mockReturnValue([]);
        const deps = makeDeps();
        const res = await performJoin(invalid({ id: 1 }), 'tok', deps, 100);
        expect(res.status).toBe('skipped-no-photo');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
    });

    test('paid join: unlock then submit, marker cleared on success', async () => {
        const deps = makeDeps();
        const res = await performJoin(invalid({ id: 7 }), 'tok', deps, 100);
        expect(res).toMatchObject({ status: 'joined', charged: 100 });
        expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);
        // marker cleared on success → no '7' key
        const state = JSON.parse(deps.joinStateStore.readRaw() || '{}') as UnlockMarkers;
        expect(state['7']).toBeUndefined();
    });

    test('unlock ok but submit fails → charged-pending-submit + marker persisted; retry does NOT re-unlock', async () => {
        const deps = makeDeps({
            submitToChallenge: jest.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true }),
        });
        const first = await performJoin(invalid({ id: 9 }), 'tok', deps, 100);
        expect(first).toMatchObject({ status: 'charged-pending-submit', charged: 100 });
        expect((JSON.parse(deps.joinStateStore.readRaw()!) as UnlockMarkers)['9']).toBeDefined();
        expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);

        // Retry: marker present → skip unlock, submit only.
        const second = await performJoin(invalid({ id: 9 }), 'tok', deps, 100);
        expect(second.status).toBe('joined');
        expect(deps.coinsUnlock).toHaveBeenCalledTimes(1); // NOT called again
        expect((JSON.parse(deps.joinStateStore.readRaw() || '{}') as UnlockMarkers)['9']).toBeUndefined();
    });

    test('a refusal (the body says no) → failed-no-charge, no submit, the claim given back', async () => {
        const store = fileWith({});
        const deps = makeDeps({
            coinsUnlock: double<'coinsUnlock'>(async () => ({ ok: false, raw: { success: false } })),
            joinStateStore: store,
        });
        const res = await performJoin(invalid({ id: 3 }), 'tok', deps, 100);
        expect(res.status).toBe('failed-no-charge');
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
        expect(store.read()).toEqual({});
    });

    describe('an unlock that got no answer (a timeout, a reset, a 5xx) may have charged', () => {
        const noAnswer = { ok: false, raw: null, unclear: true };
        const unclear = (store: ReturnType<typeof fileWith>, over: Partial<JoinDeps> = {}) =>
            makeDeps({
                coinsUnlock: double<'coinsUnlock'>(async () => noAnswer),
                getBankroll: balance({ coins: 500 }),
                joinStateStore: store,
                ...over,
            });

        test('the claim stays, flagged unconfirmed; nothing is submitted and no balance is read', async () => {
            const store = fileWith({});
            const deps = unclear(store);
            const res = await performJoin(invalid({ id: 3 }), 'tok', deps, 100);
            expect(res).toEqual({
                status: 'charged-pending-submit',
                charged: 0,
                maybeCharged: 100,
                reason: 'unconfirmed',
            });
            expect(deps.submitToChallenge).not.toHaveBeenCalled();
            expect(store.read()).toEqual({ '3': { unlockedAt: expect.any(Number), unconfirmed: true } });
            expect(deps.getBankroll).not.toHaveBeenCalled();
        });

        test('no answer object at all is the same', async () => {
            const store = fileWith({});
            const deps = unclear(store, { coinsUnlock: double<'coinsUnlock'>(async () => undefined) });
            expect((await performJoin(invalid({ id: 3 }), 'tok', deps, 100)).status).toBe('charged-pending-submit');
            expect(Object.keys(store.read())).toEqual(['3']);
        });

        test('with no store (mock mode) there is no claim to flag', async () => {
            const mock = makeDeps({ coinsUnlock: double<'coinsUnlock'>(async () => noAnswer), joinStateStore: null });
            expect((await performJoin(invalid({ id: 3 }), 'tok', mock, 100)).reason).toBe('unconfirmed');
        });

        test('a claim that is gone when it would be flagged is not invented, and no "I wasn\'t charged" is offered for it', async () => {
            // A store that reads back empty whatever is written.
            const forgetful = { readRaw: () => '{}', writeRaw: jest.fn<void, [string]>() };
            const deps = unclear(invalid<ReturnType<typeof fileWith>>(forgetful));
            expect(await performJoin(invalid({ id: 3 }), 'tok', deps, 100)).toEqual({
                status: 'charged-pending-submit',
                charged: 0,
                maybeCharged: 100,
            });
            expect(forgetful.writeRaw).toHaveBeenCalledTimes(1);
            const logged: LoggerMock = invalid(require('../../src/ts/logger'));
            expect(logged.withCategory().error.mock.calls.map(([msg]) => msg)).toContain(
                'challenge 3: the unlock marker could not be flagged as unconfirmed — it stays as a charged one',
            );
        });

        test.each([new Error('disk full'), new Error('')])(
            'a claim that cannot be flagged stays as it was: paid, never cleared (%s)',
            async (failure) => {
                let raw: string | null = null;
                let writes = 0;
                const store = {
                    readRaw: () => raw,
                    writeRaw: (data: string) => {
                        if (++writes > 1) throw failure;
                        raw = data;
                    },
                };
                const deps = unclear(invalid<ReturnType<typeof fileWith>>(store));
                // A claim whose flag was not written reads as a confirmed one: worded as charged, with nothing to forget.
                const outcome = await performJoin(invalid({ id: 3 }), 'tok', deps, 100);
                expect(outcome).toMatchObject({ status: 'charged-pending-submit', maybeCharged: 100 });
                expect(outcome.reason).toBeUndefined();
                expect(JSON.parse(raw ?? '{}')).toEqual({ '3': { unlockedAt: expect.any(Number) } });
                const logged: LoggerMock = invalid(require('../../src/ts/logger'));
                expect(
                    logged
                        .withCategory()
                        .warning.mock.calls.some(([msg]) =>
                            String(msg).startsWith('could not flag the unlock marker for 3 as unconfirmed:'),
                        ),
                ).toBe(true);
            },
        );

        test('the next attempt only submits: it never unlocks a second time, and a submit that fails says unconfirmed', async () => {
            const store = fileWith({});
            await performJoin(invalid({ id: 3 }), 'tok', unclear(store), 100);
            const failing = makeDeps({
                joinStateStore: store,
                submitToChallenge: double<'submitToChallenge'>(async () => ({ ok: false, raw: null })),
            });
            expect(await performJoin(invalid({ id: 3 }), 'tok', failing, 100)).toEqual({
                status: 'charged-pending-submit',
                charged: 0,
                reason: 'unconfirmed',
            });
            const second = makeDeps({ joinStateStore: store });
            expect((await performJoin(invalid({ id: 3 }), 'tok', second, 100)).status).toBe('joined');
            expect(second.coinsUnlock).not.toHaveBeenCalled();
            expect(second.submitToChallenge).toHaveBeenCalledTimes(1);
            expect(store.read()).toEqual({});
        });

        test('a refusal (nothing processed) gives the claim back, whether or not the body said anything', async () => {
            for (const refusal of [
                { ok: false, raw: null },
                { ok: false, raw: { success: false } },
            ]) {
                const store = fileWith({});
                const deps = unclear(store, { coinsUnlock: double<'coinsUnlock'>(async () => refusal) });
                expect(await performJoin(invalid({ id: 3 }), 'tok', deps, 100)).toEqual({
                    status: 'failed-no-charge',
                    charged: 0,
                });
                expect(store.read()).toEqual({});
            }
        });
    });

    test('claim cannot be persisted → NO coins spent (no coinsUnlock call)', async () => {
        const brokenStore = {
            readRaw: () => null,
            writeRaw: () => {
                throw new Error('disk full');
            },
        };
        const deps = makeDeps({ joinStateStore: brokenStore });
        const res = await performJoin(invalid({ id: 11 }), 'tok', deps, 100);
        expect(res.status).toBe('failed-no-charge');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
    });

    test('claim is persisted BEFORE the charge (unlock sees the marker on disk)', async () => {
        const store = makeStore();
        const deps = makeDeps({
            joinStateStore: store,
            coinsUnlock: double<'coinsUnlock'>(async (id) => {
                // The claim must already be on disk at the moment we spend.
                expect((JSON.parse(store.readRaw()!) as UnlockMarkers)[String(id)]).toBeDefined();
                return { ok: true };
            }),
        });
        const res = await performJoin(invalid({ id: 12 }), 'tok', deps, 100);
        expect(res.status).toBe('joined');
    });

    test('in-flight lock rejects a concurrent join for the same challenge', async () => {
        inFlight.add('5');
        const deps = makeDeps();
        const res = await performJoin(invalid({ id: 5 }), 'tok', deps, 100);
        expect(res.status).toBe('busy');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('cancellation before unlock → failed-no-charge, no spend', async () => {
        cancellation.isCancelled.mockReturnValue(true);
        const deps = makeDeps();
        const res = await performJoin(invalid({ id: 8 }), 'tok', deps, 100);
        expect(res.status).toBe('failed-no-charge');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('cancelling a retry of an already-charged join reports pending-submit, not "no charge"', async () => {
        const store = makeStore();
        store.writeRaw(JSON.stringify({ 14: { unlockedAt: RECENT } })); // prior cycle already unlocked
        cancellation.isCancelled.mockReturnValue(true);
        const deps = makeDeps({ joinStateStore: store });
        const res = await performJoin(invalid({ id: 14 }), 'tok', deps, 100);
        expect(res.status).toBe('charged-pending-submit');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('corrupt join-state → refuse to spend (fail-safe)', async () => {
        const corruptStore = { readRaw: () => 'not json{{', writeRaw: jest.fn() };
        const deps = makeDeps({ joinStateStore: corruptStore });
        const res = await performJoin(invalid({ id: 15 }), 'tok', deps, 100);
        expect(res.status).toBe('failed-no-charge');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('cross-process lock held → busy, no spend', async () => {
        const deps = makeDeps({ acquireUnlockLock: jest.fn(() => ({ ok: false, release: () => {} })) });
        const res = await performJoin(invalid({ id: 16 }), 'tok', deps, 100);
        expect(res.status).toBe('busy');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('cross-process lock is released after the unlock section', async () => {
        const release = jest.fn();
        const acquire = jest.fn((_id: string | number) => ({ ok: true, release }));
        const deps = makeDeps({ acquireUnlockLock: acquire });
        await performJoin(invalid({ id: 17 }), 'tok', deps, 100);
        // The unlock section and the removal of the claim after the submit take the challenge's lock; each change
        // of the claims file takes the file's own. Every lock taken is let go.
        expect(acquire.mock.calls.filter(([id]) => id === 17)).toHaveLength(2);
        expect(acquire.mock.calls.filter(([id]) => id === 'joinstate')).toHaveLength(2);
        expect(release).toHaveBeenCalledTimes(acquire.mock.calls.length);
    });
});

describe('isAutoJoinActive', () => {
    test('true when the master default is on', () => {
        settings.getEffectiveSetting.mockImplementation((k) => (k === 'autoJoin' ? true : DEFAULT_SETTINGS[k]));
        expect(isAutoJoinActive()).toBe(true);
    });
    test('true when a rule profile enables it even with master off', () => {
        settings.getEffectiveSetting.mockImplementation((k) => (k === 'autoJoin' ? false : DEFAULT_SETTINGS[k]));
        settings.getTitleRules.mockReturnValue([{ title: 'X', profile: 'p' }]);
        settings.getChallengeProfiles.mockReturnValue({ p: { autoJoin: true } });
        expect(isAutoJoinActive()).toBe(true);
    });
    test('a title-less rule whose profile enables it arms too', () => {
        settings.getEffectiveSetting.mockImplementation((k) => (k === 'autoJoin' ? false : DEFAULT_SETTINGS[k]));
        settings.getTitleRules.mockReturnValue([{ title: '', pics: 4, profile: 'Quad' }]);
        settings.getChallengeProfiles.mockReturnValue({ Quad: { autoJoin: true } });
        expect(isAutoJoinActive()).toBe(true);
    });
    test('false when master off and no profile enables it', () => {
        settings.getEffectiveSetting.mockImplementation((k) => (k === 'autoJoin' ? false : DEFAULT_SETTINGS[k]));
        settings.getTitleRules.mockReturnValue([
            { title: 'Tagged', mustIncludeTags: ['x'] },
            { title: 'Off', profile: 'p' },
            { title: 'Unknown', profile: 'missing' },
        ]);
        settings.getChallengeProfiles.mockReturnValue({ p: { autoJoin: false } });
        expect(isAutoJoinActive()).toBe(false);
        // Profiles are read once per check, not once per rule.
        expect(settings.getChallengeProfiles).toHaveBeenCalledTimes(1);
    });
    test('a facade returning no profile map is treated as empty', () => {
        settings.getEffectiveSetting.mockImplementation((k) => (k === 'autoJoin' ? false : DEFAULT_SETTINGS[k]));
        settings.getTitleRules.mockReturnValue([{ title: 'X', profile: 'p' }, invalid(null)]);
        settings.getChallengeProfiles.mockReturnValue(invalid(null));
        expect(isAutoJoinActive()).toBe(false);
    });
});

describe('resolveJoinSetting', () => {
    test('returns the value the rules resolve, passing the whole candidate', () => {
        rulesGive(() => ({ autoJoinMaxCoins: 50 }));
        settings.getEffectiveSetting.mockReturnValue(999);
        const candidate = { title: 'X', tags: ['Exhibition'], max_photo_submits: 4 };
        expect(resolveJoinSetting('autoJoinMaxCoins', invalid(candidate))).toBe(50);
        expect(settings.resolveRuleSetting).toHaveBeenCalledWith('autoJoinMaxCoins', candidate);
    });

    test('no rule sets the key → global default', () => {
        settings.getEffectiveSetting.mockReturnValue(7);
        expect(resolveJoinSetting('autoJoinMaxCoins', invalid({ title: 'X' }))).toBe(7);
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('autoJoinMaxCoins', null);
    });

    test('a rule false is honored, not treated as absent', () => {
        rulesGive(() => ({ autoJoin: false }));
        settings.getEffectiveSetting.mockReturnValue(true);
        expect(resolveJoinSetting('autoJoin', invalid({ title: 'X' }))).toBe(false);
    });

    test('a rule 0 window is honored, not treated as absent', () => {
        rulesGive(() => ({ autoJoinWithinHoursOfEnd: 0 }));
        settings.getEffectiveSetting.mockReturnValue(24);
        expect(resolveJoinSetting('autoJoinWithinHoursOfEnd', invalid({ title: 'X' }))).toBe(0);
    });

    test('degrades to the global default when the settings facade has no rule resolver', () => {
        // An older persisted facade has no resolveRuleSetting at all; the
        // optional call must not throw mid-pass.
        const saved = settings.resolveRuleSetting;
        delete (settings as { resolveRuleSetting?: unknown }).resolveRuleSetting;
        try {
            settings.getEffectiveSetting.mockReturnValue(7);
            expect(resolveJoinSetting('autoJoinMaxCoins', invalid({ title: 'X' }))).toBe(7);
        } finally {
            settings.resolveRuleSetting = saved;
        }
    });
});

describe('runJoinPass', () => {
    test('does nothing when the master is off AND there are no title rules', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => (k === 'autoJoin' ? false : undefined));
        settings.getTitleRules.mockReturnValue([]);
        const deps = makeDeps({ getMemberChallenges: openList([{ id: 1, join_coins: 0, type: 'flash' }]) });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.ran).toBe(false);
        expect(deps.getMemberChallenges).not.toHaveBeenCalled();
    });

    test('master off with only photo-tag rules (no join profile) → pass short-circuits, no API calls', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => (k === 'autoJoin' ? false : DEFAULT_SETTINGS[k]));
        // A rule that only adds photo tags carries no profile that enables
        // autoJoin, so nothing arms the pass → it must not run.
        settings.getTitleRules.mockReturnValue([{ title: 'Tagged', mustIncludeTags: ['x'] }]);
        const deps = makeDeps({ getMemberChallenges: openList([{ id: 1, join_coins: 0, type: 'flash' }]) });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.ran).toBe(false);
        expect(deps.getMemberChallenges).not.toHaveBeenCalled();
        expect(deps.getBankroll).not.toHaveBeenCalled();
    });

    test('master off but a rule profile enables autoJoin → that title joins, others skip (master → profile)', async () => {
        // Master default off; but rules exist and the profiled title turns
        // autoJoin on for itself.
        settings.getEffectiveSetting.mockImplementation((k) => (k === 'autoJoin' ? false : DEFAULT_SETTINGS[k]));
        settings.getTitleRules.mockReturnValue([{ title: 'Joinable', profile: 'p' }]);
        settings.getChallengeProfiles.mockReturnValue({ p: { autoJoin: true } });
        rulesGive((target) => (titleOf(target) === 'Joinable' ? { autoJoin: true } : {}));
        const deps = makeDeps({
            getMemberChallenges: openList([
                { id: 1, join_coins: 0, type: 'flash', title: 'Joinable' },
                { id: 2, join_coins: 0, type: 'flash', title: 'Other' },
            ]),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        const byId = Object.fromEntries(res.results.map((r) => [r.id, r.status])) as Record<string, string>;
        expect(byId[1]).toBe('joined');
        expect(byId[2]).toBe('skipped:autojoin-off');
        expect(res.joined).toBe(1);
    });

    test('master ON but a rule disables autoJoin → that title is skipped, others join', async () => {
        // Safety-relevant mirror of the enable case: an explicit false from the
        // rules must win over the master-on default (hasOwnProperty, not truthy).
        rulesGive((target) => (titleOf(target) === 'Excluded' ? { autoJoin: false } : {}));
        const deps = makeDeps({
            getMemberChallenges: openList([
                { id: 1, join_coins: 0, type: 'flash', title: 'Excluded' },
                { id: 2, join_coins: 0, type: 'flash', title: 'Other' },
            ]),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        const byId = Object.fromEntries(res.results.map((r) => [r.id, r.status])) as Record<string, string>;
        expect(byId[1]).toBe('skipped:autojoin-off');
        expect(byId[2]).toBe('joined');
    });

    test('the rules see the whole candidate including close_time, so a close-time rule can skip it', async () => {
        const CLOSE = Date.UTC(2026, 5, 15, 17, 10) / 1000;
        rulesGive((target) => (Number(target.close_time) === CLOSE ? { autoJoin: false } : {}));
        const deps = makeDeps({
            getMemberChallenges: openList([
                { id: 1, join_coins: 0, type: 'flash', title: 'Closes 17:10', close_time: CLOSE },
                { id: 2, join_coins: 0, type: 'flash', title: 'Closes later', close_time: CLOSE + 600 },
            ]),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        const byId = Object.fromEntries(res.results.map((r) => [r.id, r.status])) as Record<string, string>;
        expect(byId[1]).toBe('skipped:autojoin-off');
        expect(byId[2]).toBe('joined');
        expect(settings.resolveRuleSetting).toHaveBeenCalledWith(
            'autoJoin',
            expect.objectContaining({ title: 'Closes 17:10', close_time: CLOSE }),
        );
    });

    test('getTitleRules throwing with master off → pass short-circuits (fail-safe)', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => (k === 'autoJoin' ? false : DEFAULT_SETTINGS[k]));
        settings.getTitleRules.mockImplementation(() => {
            throw new Error('corrupt settings');
        });
        const deps = makeDeps({ getMemberChallenges: openList([{ id: 1, join_coins: 0, type: 'flash' }]) });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.ran).toBe(false);
        expect(deps.getMemberChallenges).not.toHaveBeenCalled();
    });

    test('joins free + affordable paid, respects the per-cycle budget', async () => {
        // budget 300, two paid @200 → only the first affordable
        settings.getEffectiveSetting.mockImplementation((k) => {
            const map: Record<string, unknown> = {
                autoJoin: true,
                autoJoinTypes: '',
                autoJoinMaxCoins: 250,
                autoJoinCycleCoinBudget: 300,
                fillWithoutTagMatch: true,
            };
            return map[k];
        });
        const deps = makeDeps({
            getMemberChallenges: openList([
                { id: 1, join_coins: 0, type: 'flash' },
                { id: 2, join_coins: 200, type: 'flash' },
                { id: 3, join_coins: 200, type: 'flash' },
            ]),
            getBankroll: balance({ coins: 1000 }),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.joined).toBe(2); // free + first paid
        expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);
        const statuses = res.results.map((r) => r.status);
        expect(statuses).toContain('skipped:over-cycle-budget');
    });

    describe('a paid challenge this account already paid for (an unlock marker): the pass only submits it', () => {
        const A = 'a'.repeat(32);
        const B = 'b'.repeat(32);
        const memberIdentity = require('../../src/ts/services/autoFill/memberIdentity') as typeof memberIdentityModule;
        beforeEach(() => {
            memberIdentity.__resetMemberIdCache();
            settings.getEffectiveSetting.mockImplementation((k) => {
                const map: Record<string, unknown> = {
                    autoJoin: true,
                    autoJoinTypes: '',
                    autoJoinMaxCoins: 150,
                    autoJoinCycleCoinBudget: 300,
                    fillWithoutTagMatch: true,
                };
                return map[k];
            });
        });
        const passDeps = (
            member: string | null,
            store: ReturnType<typeof fileWith>,
            coins: number,
            over: Partial<JoinDeps> = {},
        ) =>
            makeDeps({
                getMemberChallenges: openList([{ id: 2, join_coins: 100, type: 'flash' }]),
                getBankroll: balance({ coins }),
                getCurrentMemberProfile:
                    member === null ? undefined : jest.fn(async () => ({ id: member, userName: 'u' })),
                joinStateStore: store,
                ...over,
            });

        test('with a balance now below the cost (the charge lowered it) it is still submitted, and nothing is charged', async () => {
            const store = fileWith({ [`${A}:2`]: { unlockedAt: RECENT } });
            const deps = passDeps(A, store, 3);
            const res = await runJoinPass('tok', Date.now(), deps);
            expect(res.results).toEqual([{ id: 2, status: 'joined' }]);
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
            expect(deps.submitToChallenge).toHaveBeenCalledTimes(1);
            expect(store.read()).toEqual({});
        });

        test('the cost, the per-challenge cap and the cycle budget have no say', async () => {
            settings.getEffectiveSetting.mockImplementation(
                (k) => ({ autoJoin: true, autoJoinMaxCoins: 0, autoJoinCycleCoinBudget: 0 })[k as string],
            );
            const store = fileWith({ '2': { unlockedAt: RECENT } });
            const deps = passDeps(A, store, 0);
            expect((await runJoinPass('tok', Date.now(), deps)).results).toEqual([{ id: 2, status: 'joined' }]);
        });

        test('the same challenge for an account that has no marker keeps the refusal it always had', async () => {
            const store = fileWith({ [`${A}:2`]: { unlockedAt: RECENT } });
            const deps = passDeps(B, store, 3);
            const res = await runJoinPass('tok', Date.now(), deps);
            expect(res.results[0].status).toMatch(/^skipped:/);
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
            expect(deps.submitToChallenge).not.toHaveBeenCalled();
        });

        test("a marker that vanishes between the pass's read and the join's own never turns into a charge", async () => {
            const readRaw = jest
                .fn<string | null, []>()
                .mockReturnValueOnce(JSON.stringify({ [`${A}:2`]: { unlockedAt: RECENT } }))
                .mockReturnValue(null);
            const deps = passDeps(A, invalid<ReturnType<typeof fileWith>>({ readRaw, writeRaw: jest.fn() }), 500);
            const res = await runJoinPass('tok', Date.now(), deps);
            expect(res.results).toEqual([{ id: 2, status: 'failed-no-charge' }]);
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
            expect(deps.submitToChallenge).not.toHaveBeenCalled();
        });

        test('an account that cannot be identified is not trusted with a marker: the pass reports it, nothing paid or submitted', async () => {
            const store = fileWith({ '2': { unlockedAt: RECENT } });
            // Short of coins, so the cost check turns it away before the join is reached.
            const poor = passDeps(null, store, 3, { getCurrentMemberProfile: jest.fn(async () => null) });
            expect((await runJoinPass('tok', Date.now(), poor)).results).toEqual([
                { id: 2, status: 'skipped:insufficient-coins' },
            ]);
            // Enough coins: the join's own guard is what stops it.
            memberIdentity.__resetMemberIdCache();
            const rich = passDeps(null, store, 500, { getCurrentMemberProfile: jest.fn(async () => null) });
            expect((await runJoinPass('tok', Date.now(), rich)).results).toEqual([
                { id: 2, status: 'failed-no-charge' },
            ]);
            for (const deps of [poor, rich]) {
                expect(deps.coinsUnlock).not.toHaveBeenCalled();
                expect(deps.submitToChallenge).not.toHaveBeenCalled();
            }
            expect(store.writeRaw).not.toHaveBeenCalled();
        });

        test('a free candidate is not looked up at all', async () => {
            const readRaw = jest.fn(() => '{}');
            const deps = passDeps(A, invalid<ReturnType<typeof fileWith>>({ readRaw, writeRaw: jest.fn() }), 500, {
                getMemberChallenges: openList([{ id: 2, join_coins: 0, type: 'flash' }]),
            });
            await runJoinPass('tok', Date.now(), deps);
            // The join's own read, and the pruning of old claims after it (which looks at the file, not at the candidate).
            expect(readRaw).toHaveBeenCalledTimes(2);
        });
    });

    test('autoJoinExcludeTypes (raw string with spaces/case) excludes via the full pass wiring', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => {
            const map: Record<string, unknown> = {
                autoJoin: true,
                autoJoinTypes: '',
                autoJoinExcludeTypes: ' Flash , Exhibition ', // messy raw string
                autoJoinMaxCoins: 250,
                autoJoinCycleCoinBudget: 300,
                fillWithoutTagMatch: true,
            };
            return map[k];
        });
        const deps = makeDeps({
            getMemberChallenges: openList([
                { id: 1, join_coins: 0, type: 'flash' },
                { id: 2, join_coins: 0, type: 'contest' },
            ]),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        const byId = Object.fromEntries(res.results.map((r) => [r.id, r.status])) as Record<string, string>;
        expect(byId[1]).toBe('skipped:excluded-type');
        expect(byId[2]).toBe('joined');
        expect(res.joined).toBe(1);
    });

    test('autoJoinTypes (include list) narrows the join set via the full pass wiring', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => {
            const map: Record<string, unknown> = {
                autoJoin: true,
                autoJoinTypes: ' Contest ', // include only contest (messy raw string)
                autoJoinExcludeTypes: '',
                autoJoinMaxCoins: 0,
                autoJoinCycleCoinBudget: 0,
                fillWithoutTagMatch: true,
            };
            return map[k];
        });
        const deps = makeDeps({
            getMemberChallenges: openList([
                { id: 1, join_coins: 0, type: 'flash' },
                { id: 2, join_coins: 0, type: 'contest' },
            ]),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        const byId = Object.fromEntries(res.results.map((r) => [r.id, r.status])) as Record<string, string>;
        expect(byId[1]).toBe('skipped:out-of-scope');
        expect(byId[2]).toBe('joined');
        expect(res.joined).toBe(1);
    });

    test('a candidate that throws does not abort the rest of the pass', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => DEFAULT_SETTINGS[k]);
        const submit = jest
            .fn()
            .mockRejectedValueOnce(new Error('boom')) // first candidate blows up
            .mockResolvedValue({ ok: true }); // second joins fine
        const deps = makeDeps({
            getMemberChallenges: openList([
                { id: 1, join_coins: 0, type: 'flash' },
                { id: 2, join_coins: 0, type: 'flash' },
            ]),
            submitToChallenge: submit,
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.results.map((r) => r.status)).toEqual(['error', 'joined']);
        expect(res.joined).toBe(1);
    });

    test('getBankroll throwing → paid skipped, free still joins', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => DEFAULT_SETTINGS[k]);
        const deps = makeDeps({
            getMemberChallenges: openList([
                { id: 1, join_coins: 0, type: 'flash' },
                { id: 2, join_coins: 100, type: 'flash' },
            ]),
            getBankroll: double<'getBankroll'>(async () => {
                throw new Error('network');
            }),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.joined).toBe(1);
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('null bankroll → paid skipped, free still joins', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => {
            const map: Record<string, unknown> = {
                autoJoin: true,
                autoJoinTypes: '',
                autoJoinMaxCoins: 250,
                autoJoinCycleCoinBudget: 300,
                fillWithoutTagMatch: true,
            };
            return map[k];
        });
        const deps = makeDeps({
            getMemberChallenges: openList([
                { id: 1, join_coins: 0, type: 'flash' },
                { id: 2, join_coins: 100, type: 'flash' },
            ]),
            getBankroll: double<'getBankroll'>(async () => null),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.joined).toBe(1);
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });
});

/**
 * The join window end-to-end through the pass: hours → seconds against the
 * candidate's own close_time, deferral rather than permanent rejection, and the
 * fail-closed behavior when close_time is absent from the payload.
 */
describe('runJoinPass — join window', () => {
    const HOUR = 3600;
    const NOW_MS = 1_700_000_000_000;
    const NOW_SEC = NOW_MS / 1000;
    const withWindow = (hours: number) =>
        settings.getEffectiveSetting.mockImplementation((k) =>
            k === 'autoJoinWithinHoursOfEnd' ? hours : DEFAULT_SETTINGS[k],
        );

    test('defers a candidate that is outside the window, spending nothing', async () => {
        withWindow(24);
        const deps = makeDeps({
            getMemberChallenges: openList([
                { id: 1, join_coins: 0, type: 'flash', title: 'Far', close_time: NOW_SEC + 48 * HOUR },
            ]),
        });
        const res = await runJoinPass('tok', NOW_MS, deps);
        expect(res.ran).toBe(true);
        expect(res.joined).toBe(0);
        expect(res.results[0].status).toBe('skipped:too-early');
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
    });

    test('joins the same candidate once it is inside the window', async () => {
        withWindow(24);
        const deps = makeDeps({
            getMemberChallenges: openList([
                { id: 1, join_coins: 0, type: 'flash', title: 'Near', close_time: NOW_SEC + 5 * HOUR },
            ]),
        });
        const res = await runJoinPass('tok', NOW_MS, deps);
        expect(res.joined).toBe(1);
        expect(deps.submitToChallenge).toHaveBeenCalledTimes(1);
    });

    describe('Join Early for Missions', () => {
        const far = (id: number) => ({
            id,
            join_coins: 0,
            type: 'flash',
            title: `Far ${id}`,
            close_time: NOW_SEC + 48 * HOUR,
        });
        // `joinedTurbos`: the turbo states of the already-joined challenges.
        const farDeps = (joinedTurbos: string[] = []) =>
            makeDeps({
                getMemberChallenges: openList([far(1), far(2), far(3)]),
                getActiveChallenges: double<'getActiveChallenges'>(async () => ({
                    challenges: joinedTurbos.map((state, i) => ({ id: 100 + i, member: { turbo: { state } } })),
                })),
            });
        const withJoinEarly = (on: boolean) =>
            settings.getEffectiveSetting.mockImplementation((k) =>
                k === 'autoJoinWithinHoursOfEnd' ? 24 : k === 'missionJoinEarly' ? on : DEFAULT_SETTINGS[k],
            );
        const statuses = (res: Awaited<ReturnType<typeof runJoinPass>>) => res.results.map((r) => r.status);
        const earlyNotices = () =>
            invalid<LoggerMock>(require('../../src/ts/logger'))
                .withCategory()
                .info.mock.calls.map(([msg]) => msg)
                .filter((msg) => msg.includes('early for the active missions'));

        test('a join mission lifts the window until it is met, and each join counts it down', async () => {
            withJoinEarly(true);
            const missions = { join: 2, fill: 0, turbo: 0, vote: 0 };
            const res = await runJoinPass('tok', NOW_MS, farDeps(), missions);
            expect(statuses(res)).toEqual(['joined', 'joined', 'skipped:too-early']);
            expect(missions.join).toBe(0);
        });

        test('a turbo mission joins early only for the turbos it is short of', async () => {
            withJoinEarly(true);
            // 3 wins needed; one joined challenge holds a turbo still to win, two are used or won.
            const deps = farDeps(['FREE', 'USED', 'WON']);
            const missions = { join: 0, fill: 0, turbo: 3, vote: 0 };
            const res = await runJoinPass('tok', NOW_MS, deps, missions);
            expect(statuses(res)).toEqual(['joined', 'joined', 'skipped:too-early']);
            // A join is not a turbo win: the turbo mission counts down only when one is won.
            expect(missions.turbo).toBe(3);
            expect(deps.getActiveChallenges).toHaveBeenCalledWith('tok');
            expect(earlyNotices()).toEqual(['joining up to 2 challenge(s) early for the active missions']);
        });

        test('a turbo mission joins the earliest closing challenge before later ones', async () => {
            withJoinEarly(true);
            settings.getEffectiveSetting.mockImplementation((k) =>
                k === 'autoJoinWithinHoursOfEnd' ? 1 : k === 'missionJoinEarly' ? true : DEFAULT_SETTINGS[k],
            );
            const deps = makeDeps({
                getMemberChallenges: openList([
                    far(1),
                    { ...far(2), title: 'Ends in two hours', close_time: NOW_SEC + 2 * HOUR },
                ]),
                getActiveChallenges: double<'getActiveChallenges'>(async () => ({ challenges: [] })),
            });

            const res = await runJoinPass('tok', NOW_MS, deps, { join: 0, fill: 0, turbo: 1, vote: 0 });

            expect(res.results).toEqual([
                { id: 2, status: 'joined' },
                { id: 1, status: 'skipped:too-early' },
            ]);
            expect(deps.submitToChallenge).toHaveBeenCalledWith(2, ['imgA'], 'tok');
        });

        test('a turbo mission puts candidates without a close time after timed candidates', async () => {
            withJoinEarly(true);
            const deps = makeDeps({
                getMemberChallenges: openList([
                    { ...far(1), close_time: undefined },
                    { ...far(2), close_time: NOW_SEC + 2 * HOUR },
                    { ...far(3), close_time: undefined },
                ]),
                getActiveChallenges: double<'getActiveChallenges'>(async () => ({ challenges: [] })),
            });

            const res = await runJoinPass('tok', NOW_MS, deps, { join: 0, fill: 0, turbo: 1, vote: 0 });

            expect(res.results.map((result) => result.id)).toEqual([2, 1, 3]);
            expect(deps.submitToChallenge).toHaveBeenCalledTimes(1);
            expect(deps.submitToChallenge).toHaveBeenCalledWith(2, ['imgA'], 'tok');
        });

        test('a turbo mission skips expired and invalid close times before joining a live challenge', async () => {
            withJoinEarly(true);
            settings.getEffectiveSetting.mockImplementation((k) =>
                k === 'autoJoinWithinHoursOfEnd' ? 1 : k === 'missionJoinEarly' ? true : DEFAULT_SETTINGS[k],
            );
            const deps = makeDeps({
                getMemberChallenges: openList([
                    { ...far(1), close_time: NOW_SEC - 60 },
                    { ...far(2), close_time: undefined },
                    { ...far(3), close_time: 0 },
                    { ...far(4), close_time: NOW_SEC + 2 * HOUR },
                ]),
                getActiveChallenges: double<'getActiveChallenges'>(async () => ({ challenges: [] })),
            });

            const res = await runJoinPass('tok', NOW_MS, deps, { join: 0, fill: 0, turbo: 1, vote: 0 });

            expect(res.results).toEqual([
                { id: 3, status: 'skipped:close-time-unknown' },
                { id: 1, status: 'skipped:already-closed' },
                { id: 4, status: 'joined' },
                { id: 2, status: 'skipped:close-time-unknown' },
            ]);
            expect(deps.submitToChallenge).toHaveBeenCalledTimes(1);
            expect(deps.submitToChallenge).toHaveBeenCalledWith(4, ['imgA'], 'tok');
        });

        test('turbos waiting in joined challenges (free, playing, on the timer) cover the mission', async () => {
            withJoinEarly(true);
            const deps = farDeps(['FREE', 'IN_PROGRESS', 'TIMER']);
            const res = await runJoinPass('tok', NOW_MS, deps, { join: 0, fill: 0, turbo: 3, vote: 0 });
            expect(statuses(res)).toEqual(['skipped:too-early', 'skipped:too-early', 'skipped:too-early']);
        });

        test('a turbo whose timer opens after the mission expires does not suppress a timely join', async () => {
            withJoinEarly(true);
            settings.getEffectiveSetting.mockImplementation((k) =>
                k === 'autoJoinWithinHoursOfEnd' ? 1 : k === 'missionJoinEarly' ? true : DEFAULT_SETTINGS[k],
            );
            const deps = makeDeps({
                getMemberChallenges: openList([far(1), { ...far(2), close_time: NOW_SEC + 2 * HOUR }]),
                getActiveChallenges: double<'getActiveChallenges'>(async () => ({
                    challenges: [
                        {
                            id: 100,
                            close_time: NOW_SEC + 48 * HOUR,
                            member: { turbo: { state: 'TIMER', time_to_open: NOW_SEC + 24 * HOUR } },
                        },
                    ],
                })),
            });

            const res = await runJoinPass('tok', NOW_MS, deps, {
                join: 0,
                fill: 0,
                turbo: 1,
                vote: 0,
                turboRequirements: [{ remaining: 1, expiresAtSec: NOW_SEC + 3 * HOUR }],
            });

            expect(res.results).toEqual([
                { id: 2, status: 'joined' },
                { id: 1, status: 'skipped:too-early' },
            ]);
            expect(deps.submitToChallenge).toHaveBeenCalledWith(2, ['imgA'], 'tok');
        });

        test('only turbos winnable before the mission deadline cover its remaining win', async () => {
            withJoinEarly(true);
            const deadline = NOW_SEC + 3 * HOUR;
            const cases = [
                { name: 'free now', turbo: { state: 'FREE' }, close: NOW_SEC + 48 * HOUR, joins: 0 },
                { name: 'playing now', turbo: { state: 'IN_PROGRESS' }, close: NOW_SEC + 48 * HOUR, joins: 0 },
                {
                    name: 'timer opens in time',
                    turbo: { state: 'TIMER', time_to_open: NOW_SEC + HOUR },
                    close: NOW_SEC + 48 * HOUR,
                    joins: 0,
                },
                {
                    name: 'timer opens at deadline',
                    turbo: { state: 'TIMER', time_to_open: deadline },
                    close: NOW_SEC + 48 * HOUR,
                    joins: 1,
                },
                {
                    name: 'timer opens after close',
                    turbo: { state: 'TIMER', time_to_open: NOW_SEC + HOUR },
                    close: NOW_SEC + 30 * 60,
                    joins: 1,
                },
                { name: 'timer has no open time', turbo: { state: 'TIMER' }, close: NOW_SEC + 48 * HOUR, joins: 1 },
                {
                    name: 'timer has invalid open time',
                    turbo: { state: 'TIMER', time_to_open: 0 },
                    close: NOW_SEC + 48 * HOUR,
                    joins: 1,
                },
                { name: 'challenge already closed', turbo: { state: 'FREE' }, close: NOW_SEC - 1, joins: 1 },
                { name: 'challenge close time missing', turbo: { state: 'FREE' }, close: undefined, joins: 1 },
            ];
            for (const { name, turbo, close, joins } of cases) {
                const deps = makeDeps({
                    getMemberChallenges: openList([far(1)]),
                    getActiveChallenges: double<'getActiveChallenges'>(async () => ({
                        challenges: [{ id: 100, close_time: close, member: { turbo } }],
                    })),
                });
                const res = await runJoinPass('tok', NOW_MS, deps, {
                    join: 0,
                    fill: 0,
                    turbo: 1,
                    vote: 0,
                    turboRequirements: [{ remaining: 1, expiresAtSec: deadline }],
                });
                expect({ name, joined: res.joined }).toEqual({ name, joined: joins });
            }
        });

        test('multiple turbo missions use each deadline with its own remaining wins', async () => {
            withJoinEarly(true);
            settings.getEffectiveSetting.mockImplementation((k) =>
                k === 'autoJoinWithinHoursOfEnd' ? 1 : k === 'missionJoinEarly' ? true : DEFAULT_SETTINGS[k],
            );
            const deps = makeDeps({
                getMemberChallenges: openList([
                    far(1),
                    { ...far(2), close_time: NOW_SEC + 2 * HOUR },
                    far(3),
                    far(4),
                    far(5),
                ]),
                getActiveChallenges: double<'getActiveChallenges'>(async () => ({
                    challenges: [1, 2, 3, 4].map((id) => ({
                        id: 100 + id,
                        close_time: NOW_SEC + 48 * HOUR,
                        member: { turbo: { state: 'TIMER', time_to_open: NOW_SEC + 3 * HOUR } },
                    })),
                })),
            });

            const res = await runJoinPass('tok', NOW_MS, deps, {
                join: 0,
                fill: 0,
                turbo: 4,
                vote: 0,
                turboRequirements: [
                    { remaining: 1, expiresAtSec: NOW_SEC + 2 * HOUR },
                    { remaining: 4, expiresAtSec: NOW_SEC + 24 * HOUR },
                ],
            });

            expect(res.results).toEqual([
                { id: 2, status: 'joined' },
                { id: 1, status: 'skipped:too-early' },
                { id: 3, status: 'skipped:too-early' },
                { id: 4, status: 'skipped:too-early' },
                { id: 5, status: 'skipped:too-early' },
            ]);
            expect(deps.submitToChallenge).toHaveBeenCalledTimes(1);
        });

        test('a challenge joined for a turbo mission stops the next cycle joining another for it', async () => {
            withJoinEarly(true);
            const missions = { join: 0, fill: 0, turbo: 1, vote: 0 };
            const first = await runJoinPass('tok', NOW_MS, farDeps([]), missions);
            expect(statuses(first)).toEqual(['joined', 'skipped:too-early', 'skipped:too-early']);
            // Next cycle: the new challenge's turbo is on its timer, the mission still needs 1.
            const second = await runJoinPass('tok', NOW_MS, farDeps(['TIMER']), missions);
            expect(statuses(second)).toEqual(['skipped:too-early', 'skipped:too-early', 'skipped:too-early']);
        });

        test('a joined challenge without turbo data holds no turbo to win', async () => {
            withJoinEarly(true);
            const deps = makeDeps({
                getMemberChallenges: openList([far(1), far(2)]),
                getActiveChallenges: double<'getActiveChallenges'>(async () => ({
                    challenges: [null, { id: 1 }, { id: 2, member: {} }, { id: 3, member: { turbo: {} } }],
                })),
            });
            const res = await runJoinPass('tok', NOW_MS, deps, { join: 0, fill: 0, turbo: 1, vote: 0 });
            expect(statuses(res)).toEqual(['joined', 'skipped:too-early']);
        });

        test('an unreadable active list, or none to read, never joins early for turbo', async () => {
            withJoinEarly(true);
            const failed = makeDeps({
                getMemberChallenges: openList([far(1)]),
                getActiveChallenges: double<'getActiveChallenges'>(async () => ({ challenges: [], fetchFailed: true })),
            });
            const none = makeDeps({ getMemberChallenges: openList([far(1)]) });
            for (const deps of [failed, none]) {
                const res = await runJoinPass('tok', NOW_MS, deps, { join: 0, fill: 0, turbo: 2, vote: 0 });
                expect(statuses(res)).toEqual(['skipped:too-early']);
            }
        });

        test('with both missions active, the larger need sets how many join early', async () => {
            withJoinEarly(true);
            const res = await runJoinPass('tok', NOW_MS, farDeps(), { join: 1, fill: 0, turbo: 2, vote: 0 });
            expect(statuses(res)).toEqual(['joined', 'joined', 'skipped:too-early']);
        });

        test('keeps the window while the setting is off, even with missions needing joins', async () => {
            withJoinEarly(false);
            const res = await runJoinPass('tok', NOW_MS, farDeps(), { join: 2, fill: 0, turbo: 2, vote: 0 });
            expect(statuses(res)).toEqual(['skipped:too-early', 'skipped:too-early', 'skipped:too-early']);
        });

        test('without a mission read (none followed or unreadable) the window stays', async () => {
            withJoinEarly(true);
            const res = await runJoinPass('tok', NOW_MS, farDeps());
            expect(statuses(res)).toEqual(['skipped:too-early', 'skipped:too-early', 'skipped:too-early']);
        });

        test('a met mission leaves the window in place', async () => {
            withJoinEarly(true);
            const res = await runJoinPass('tok', NOW_MS, farDeps(), { join: 0, fill: 0, turbo: 0, vote: 0 });
            expect(statuses(res)).toEqual(['skipped:too-early', 'skipped:too-early', 'skipped:too-early']);
            expect(earlyNotices()).toEqual([]);
        });
    });

    test('deferral is per-cycle: the same candidate joins on a later pass', async () => {
        withWindow(24);
        const closeTime = NOW_SEC + 30 * HOUR;
        const candidate = { id: 1, join_coins: 0, type: 'flash', title: 'Later', close_time: closeTime };
        const deps = makeDeps({ getMemberChallenges: openList([candidate]) });

        const early = await runJoinPass('tok', NOW_MS, deps);
        expect(early.results[0].status).toBe('skipped:too-early');

        // Ten hours later the same candidate is now 20h from closing.
        const later = await runJoinPass('tok', NOW_MS + 10 * HOUR * 1000, deps);
        expect(later.joined).toBe(1);
    });

    test('a per-title inline window overrides the global one', async () => {
        // Global says "join on sight"; the rule for this title says "only in the
        // last 24h" — the title must still be deferred.
        withWindow(0);
        rulesGive((target) => (titleOf(target) === 'abc' ? { autoJoinWithinHoursOfEnd: 24 } : {}));
        const deps = makeDeps({
            getMemberChallenges: openList([
                { id: 1, join_coins: 0, type: 'flash', title: 'abc', close_time: NOW_SEC + 48 * HOUR },
                { id: 2, join_coins: 0, type: 'flash', title: 'other', close_time: NOW_SEC + 48 * HOUR },
            ]),
        });
        const res = await runJoinPass('tok', NOW_MS, deps);
        expect(res.results[0].status).toBe('skipped:too-early');
        expect(res.results[1].status).toBe('joined');
    });

    test('a window of 0 keeps the historical join-on-sight behavior', async () => {
        withWindow(0);
        const deps = makeDeps({
            getMemberChallenges: openList([
                { id: 1, join_coins: 0, type: 'flash', title: 'Far', close_time: NOW_SEC + 90 * 86400 },
            ]),
        });
        expect((await runJoinPass('tok', NOW_MS, deps)).joined).toBe(1);
    });

    test('a candidate with no close_time joins normally when no window is set', async () => {
        withWindow(0);
        const deps = makeDeps({
            getMemberChallenges: openList([{ id: 1, join_coins: 0, type: 'flash', title: 'NoTime' }]),
        });
        expect((await runJoinPass('tok', NOW_MS, deps)).joined).toBe(1);
    });

    test('fail-closed: a missing close_time is deferred, not joined, while a window is set', async () => {
        withWindow(24);
        const deps = makeDeps({
            getMemberChallenges: openList([{ id: 1, join_coins: 0, type: 'flash', title: 'NoTime' }]),
        });
        const res = await runJoinPass('tok', NOW_MS, deps);
        expect(res.joined).toBe(0);
        expect(res.results[0].status).toBe('skipped:close-time-unknown');
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
    });

    test('the missing-close_time diagnostic logs the payload shape once per pass', async () => {
        withWindow(24);
        const logger: LoggerMock = invalid(require('../../src/ts/logger'));
        const deps = makeDeps({
            getMemberChallenges: openList([
                { id: 1, join_coins: 0, type: 'flash', title: 'A' },
                { id: 2, join_coins: 0, type: 'flash', title: 'B' },
            ]),
        });
        await runJoinPass('tok', NOW_MS, deps);
        const warnings = logger
            .withCategory()
            .warning.mock.calls.filter(([msg]) => String(msg).includes('no readable close_time'));
        expect(warnings).toHaveLength(1);
        // The message must name the fields actually present, so one real run
        // reveals whether the upstream payload carries close_time at all.
        expect(warnings[0][0]).toContain('id, join_coins, type, title');
    });

    test('an already-closed candidate in the open list is refused', async () => {
        withWindow(24);
        const deps = makeDeps({
            getMemberChallenges: openList([
                { id: 1, join_coins: 0, type: 'flash', title: 'Dead', close_time: NOW_SEC - 60 },
            ]),
        });
        const res = await runJoinPass('tok', NOW_MS, deps);
        expect(res.results[0].status).toBe('skipped:already-closed');
    });

    test('the window also defers a paid candidate before any unlock', async () => {
        withWindow(24);
        const deps = makeDeps({
            getMemberChallenges: openList([
                { id: 1, join_coins: 100, type: 'flash', title: 'PaidFar', close_time: NOW_SEC + 48 * HOUR },
            ]),
        });
        const res = await runJoinPass('tok', NOW_MS, deps);
        expect(res.results[0].status).toBe('skipped:too-early');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('the manual single-join path ignores the window entirely', async () => {
        withWindow(24);
        const deps = makeDeps({
            getMemberChallenges: openList([
                { id: 7, join_coins: 0, type: 'flash', title: 'Far', close_time: NOW_SEC + 48 * HOUR },
            ]),
        });
        const res = await joinChallengeSingle(7, 'tok', deps, { spendCoins: false });
        expect(res.status).toBe('joined');
    });
});

describe('runJoinPass — inline rule arming', () => {
    test('master off but an inline autoJoin:true rule arms the pass', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => (k === 'autoJoin' ? false : DEFAULT_SETTINGS[k]));
        settings.getTitleRules.mockReturnValue([{ title: 'Joinable', autoJoin: true }]);
        rulesGive((t) => (titleOf(t) === 'Joinable' ? { autoJoin: true } : {}));
        const deps = makeDeps({
            getMemberChallenges: openList([
                { id: 1, join_coins: 0, type: 'flash', title: 'Joinable' },
                { id: 2, join_coins: 0, type: 'flash', title: 'Other' },
            ]),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.ran).toBe(true);
        expect(res.results[0].status).toBe('joined');
        expect(res.results[1].status).toBe('skipped:autojoin-off');
    });

    test('an inline autoJoin:false is not rescued by a profile that says true', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => (k === 'autoJoin' ? false : DEFAULT_SETTINGS[k]));
        settings.getTitleRules.mockReturnValue([{ title: 'X', profile: 'p', autoJoin: false }]);
        settings.getChallengeProfiles.mockReturnValue({ p: { autoJoin: true } });
        rulesGive(() => ({ autoJoin: false }));
        const deps = makeDeps({
            getMemberChallenges: openList([{ id: 1, join_coins: 0, type: 'flash', title: 'X' }]),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.ran).toBe(false);
        expect(deps.getMemberChallenges).not.toHaveBeenCalled();
    });

    test('a rule opt-in bypasses an excluded type', async () => {
        settings.getEffectiveSetting.mockImplementation((k) =>
            k === 'autoJoinExcludeTypes' ? 'flash' : DEFAULT_SETTINGS[k],
        );
        rulesGive((t) => (titleOf(t) === 'Wanted' ? { autoJoin: true } : {}));
        settings.hasRuleJoinOptIn.mockImplementation((t) => titleOf(t) === 'Wanted');
        const deps = makeDeps({
            getMemberChallenges: openList([
                { id: 1, join_coins: 0, type: 'flash', title: 'Wanted' },
                { id: 2, join_coins: 0, type: 'flash', title: 'Unwanted' },
            ]),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.results[0].status).toBe('joined');
        expect(res.results[1].status).toBe('skipped:excluded-type');
    });

    test('a window-only rule does NOT bypass an excluded type (it says when, not whether)', async () => {
        settings.getEffectiveSetting.mockImplementation((k) =>
            k === 'autoJoinExcludeTypes' ? 'flash' : DEFAULT_SETTINGS[k],
        );
        rulesGive(() => ({ autoJoinWithinHoursOfEnd: 24 }));
        const deps = makeDeps({
            getMemberChallenges: openList([{ id: 1, join_coins: 0, type: 'flash', title: 'Timed' }]),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.results[0].status).toBe('skipped:excluded-type');
    });
});

/**
 * Challenge-tag rules through the whole pass: the global filters, and a rule
 * keyed on the candidate's own tags rather than its title.
 */
describe('runJoinPass — challenge tags', () => {
    const candidates = () => [
        { id: 1, join_coins: 0, type: 'default', title: 'Going Viral', tags: ['Turbo'] },
        { id: 2, join_coins: 0, type: 'exhibition', title: 'My Best Shot', tags: ['Exhibition', 'Comm'] },
    ];

    test('a global require-list narrows to challenges carrying the tag', async () => {
        settings.getEffectiveSetting.mockImplementation((k) =>
            k === 'autoJoinChallengeTags' ? 'exhibition' : DEFAULT_SETTINGS[k],
        );
        const deps = makeDeps({ getMemberChallenges: double<'getMemberChallenges'>(async () => candidates()) });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.results[0].status).toBe('skipped:tag-out-of-scope');
        expect(res.results[1].status).toBe('joined');
    });

    test('a global exclude-list vetoes', async () => {
        settings.getEffectiveSetting.mockImplementation((k) =>
            k === 'autoJoinExcludeChallengeTags' ? 'comm' : DEFAULT_SETTINGS[k],
        );
        const deps = makeDeps({ getMemberChallenges: double<'getMemberChallenges'>(async () => candidates()) });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.results[0].status).toBe('joined');
        expect(res.results[1].status).toBe('skipped:excluded-tag');
    });

    test('the candidate object (not just its title) reaches the rule lookup', async () => {
        // A tag-keyed rule has no title to match on, so this only passes if the
        // pass hands the whole candidate to the facade.
        const seen: RuleMatchChallenge[] = [];
        settings.resolveRuleSetting.mockImplementation((key, target) => {
            seen.push(invalid(target));
            return null;
        });
        const deps = makeDeps({ getMemberChallenges: double<'getMemberChallenges'>(async () => candidates()) });
        await runJoinPass('tok', Date.now(), deps);
        expect(seen.some((t) => Array.isArray(t?.tags) && t.tags.includes('Turbo'))).toBe(true);
    });

    test('a tag-keyed rule can set the join window for every challenge carrying that tag', async () => {
        const HOUR = 3600;
        const nowMs = 1_700_000_000_000;
        const nowSec = nowMs / 1000;
        rulesGive((target) => ((target?.tags || []).includes('Exhibition') ? { autoJoinWithinHoursOfEnd: 24 } : {}));
        const deps = makeDeps({
            getMemberChallenges: openList([
                // Tagged Exhibition and far from closing -> deferred by the rule.
                {
                    id: 2,
                    join_coins: 0,
                    type: 'exhibition',
                    title: 'My Best Shot',
                    tags: ['Exhibition'],
                    close_time: nowSec + 200 * HOUR,
                },
                // Not tagged Exhibition -> no window -> joins on sight.
                {
                    id: 1,
                    join_coins: 0,
                    type: 'default',
                    title: 'Going Viral',
                    tags: ['Turbo'],
                    close_time: nowSec + 200 * HOUR,
                },
            ]),
        });
        const res = await runJoinPass('tok', nowMs, deps);
        expect(res.results[0].status).toBe('skipped:too-early');
        expect(res.results[1].status).toBe('joined');
    });
});

describe('joinChallengeSingle — manual', () => {
    test('paid without spendCoins → needs-confirm, no spend', async () => {
        const deps = makeDeps({
            getMemberChallenges: openList([{ id: 2, join_coins: 100, type: 'flash' }]),
        });
        const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: false });
        expect(res).toMatchObject({ status: 'needs-confirm', cost: 100 });
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('unavailable when not in the open list', async () => {
        const deps = makeDeps({ getMemberChallenges: openList([]) });
        const res = await joinChallengeSingle(999, 'tok', deps, { spendCoins: true });
        expect(res.status).toBe('unavailable');
    });

    test('paid with spendCoins joins after affordability check', async () => {
        const deps = makeDeps({
            getMemberChallenges: openList([{ id: 2, join_coins: 100, type: 'flash' }]),
            getBankroll: balance({ coins: 500 }),
        });
        const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: true });
        expect(res.status).toBe('joined');
        expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);
    });

    describe('expectedCost — consent covers the price the user was shown', () => {
        const priced = (join_coins: number) =>
            makeDeps({
                getMemberChallenges: openList([{ id: 2, join_coins, type: 'flash' }]),
                getBankroll: balance({ coins: 500 }),
            });
        const untouched = (deps: ReturnType<typeof makeDeps>) =>
            [deps.getBankroll, deps.coinsUnlock, deps.submitToChallenge].every(
                (fn) => jest.mocked(fn).mock.calls.length === 0,
            );

        test.each([[100], [150], [100.5]])(
            'a live cost of 100 within the confirmed %p is joined',
            async (expectedCost) => {
                const deps = priced(100);
                const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: true, expectedCost });
                expect(res).toMatchObject({ status: 'joined', cost: 100 });
                expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);
            },
        );

        test.each([[99], [0], [99.99]])(
            'a live cost of 100 above the confirmed %p needs a new confirmation, with the live cost, and unlocks nothing',
            async (expectedCost) => {
                const deps = priced(100);
                expect(await joinChallengeSingle(2, 'tok', deps, { spendCoins: true, expectedCost })).toEqual({
                    status: 'needs-confirm',
                    challengeId: 2,
                    cost: 100,
                });
                expect(untouched(deps)).toBe(true);
            },
        );

        test('without it the current cost is accepted, as ever', async () => {
            const deps = priced(300);
            expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).status).toBe('joined');
        });

        describe('a retry after coins were charged and the submit failed (an unlock marker is left)', () => {
            const MARKED = JSON.stringify({ '2': { unlockedAt: RECENT } });
            const retrying = (marker: string | null, over: NonNullable<Parameters<typeof makeDeps>[0]> = {}) => {
                const deps = makeDeps({
                    getMemberChallenges: openList([{ id: 2, join_coins: 100, type: 'flash' }]),
                    getBankroll: balance({ coins: 500 }),
                    joinStateStore: { readRaw: () => marker, writeRaw: jest.fn() },
                    ...over,
                });
                return deps;
            };

            test('only submits: a price that rose since the charge is not asked about again', async () => {
                const deps = retrying(MARKED);
                const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: true, expectedCost: 40 });
                expect(res).toMatchObject({ status: 'joined', cost: 100 });
                expect(deps.coinsUnlock).not.toHaveBeenCalled();
                expect(deps.submitToChallenge).toHaveBeenCalledTimes(1);
                expect(deps.getBankroll).not.toHaveBeenCalled();
            });

            test('only submits with a balance too low to pay the cost again', async () => {
                const deps = retrying(MARKED, { getBankroll: balance({ coins: 3 }) });
                const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: true, expectedCost: 100 });
                expect(res.status).toBe('joined');
                expect(deps.coinsUnlock).not.toHaveBeenCalled();
                expect(deps.submitToChallenge).toHaveBeenCalledTimes(1);
            });

            test('a balance that cannot be read does not stop it either', async () => {
                const deps = retrying(MARKED, { getBankroll: double<'getBankroll'>(async () => null) });
                expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).status).toBe('joined');
                expect(deps.coinsUnlock).not.toHaveBeenCalled();
            });

            test('a submit that fails again is reported as pending, still without a second charge', async () => {
                const deps = retrying(MARKED, {
                    submitToChallenge: double<'submitToChallenge'>(async () => ({ ok: false, raw: null })),
                });
                const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: true });
                expect(res.status).toBe('charged-pending-submit');
                expect(deps.coinsUnlock).not.toHaveBeenCalled();
            });

            test('without the marker nothing changes: a risen price needs consent, and a low balance is refused', async () => {
                const risen = retrying(null);
                expect(await joinChallengeSingle(2, 'tok', risen, { spendCoins: true, expectedCost: 40 })).toEqual({
                    status: 'needs-confirm',
                    challengeId: 2,
                    cost: 100,
                });
                expect(risen.coinsUnlock).not.toHaveBeenCalled();
                const poor = retrying(null, { getBankroll: balance({ coins: 3 }) });
                expect((await joinChallengeSingle(2, 'tok', poor, { spendCoins: true })).status).toBe(
                    'skipped-unaffordable',
                );
            });

            test('a marker for another challenge does not count', async () => {
                const deps = retrying(JSON.stringify({ '9': { unlockedAt: RECENT } }));
                expect((await joinChallengeSingle(2, 'tok', deps, { expectedCost: 40, spendCoins: true })).status).toBe(
                    'needs-confirm',
                );
            });

            test('an unreadable marker file reads as no marker: the gates stay, and nothing is spent', async () => {
                const corrupt = retrying('{ not json');
                expect(
                    (await joinChallengeSingle(2, 'tok', corrupt, { spendCoins: true, expectedCost: 40 })).status,
                ).toBe('needs-confirm');
                const unreadable = retrying(null, {
                    joinStateStore: {
                        readRaw: () => {
                            throw new Error('disk');
                        },
                        writeRaw: jest.fn(),
                    },
                });
                expect(
                    (await joinChallengeSingle(2, 'tok', unreadable, { spendCoins: true, expectedCost: 40 })).status,
                ).toBe('needs-confirm');
                expect(corrupt.coinsUnlock).not.toHaveBeenCalled();
                expect(unreadable.coinsUnlock).not.toHaveBeenCalled();
            });

            test('a free challenge never looks at the marker on its own: only the join itself reads it, and never clears it', async () => {
                const writeRaw = jest.fn();
                const readRaw = jest.fn(() => MARKED);
                const deps = makeDeps({
                    getMemberChallenges: openList([{ id: 2, join_coins: 0, type: 'flash' }]),
                    joinStateStore: { readRaw, writeRaw },
                });
                expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: false })).status).toBe('joined');
                // The join reads once, to know whether coins were spent, and the pruning of old claims reads twice
                // (a look, then the rewrite of what it drops); a free join spent none and removes nothing.
                expect(readRaw).toHaveBeenCalledTimes(3);
                expect(writeRaw).not.toHaveBeenCalled();
            });

            test('without spendCoins (the CLI first call, the Discover ask) it submits at once, with nothing to ask or pay', async () => {
                const deps = retrying(MARKED);
                const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: false });
                expect(res).toMatchObject({ status: 'joined', cost: 100 });
                expect(deps.coinsUnlock).not.toHaveBeenCalled();
                expect(deps.getBankroll).not.toHaveBeenCalled();
                expect(deps.submitToChallenge).toHaveBeenCalledTimes(1);
            });

            describe('the marker is read twice: by the caller, then by the join', () => {
                const flaky = (second: () => string | null) => {
                    const readRaw = jest.fn<string | null, []>().mockReturnValueOnce(MARKED).mockImplementation(second);
                    return { readRaw, deps: retrying(null, { joinStateStore: { readRaw, writeRaw: jest.fn() } }) };
                };

                test('another process cleared it in between: nothing is unlocked, no charge nobody agreed to', async () => {
                    const { readRaw, deps } = flaky(() => null);
                    const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: true, expectedCost: 40 });
                    expect(res.status).toBe('failed-no-charge');
                    // The caller's read, the join's own, and the one look of the pruning that follows.
                    expect(readRaw).toHaveBeenCalledTimes(3);
                    expect(deps.coinsUnlock).not.toHaveBeenCalled();
                    expect(deps.submitToChallenge).not.toHaveBeenCalled();
                });

                test('the file became unreadable in between: the same', async () => {
                    const { readRaw, deps } = flaky(() => {
                        throw new Error('disk');
                    });
                    expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).status).toBe(
                        'failed-no-charge',
                    );
                    expect(deps.coinsUnlock).not.toHaveBeenCalled();
                    // Two reads: the caller's, and the join's own, which is the one that stopped it (a first read
                    // that failed would never have got that far), and the photo was never even looked for. The third is the
                    // one look of the pruning that follows.
                    expect(readRaw).toHaveBeenCalledTimes(3);
                    expect(photoPicker.pickPhotosForChallenge).not.toHaveBeenCalled();
                    expect(deps.submitToChallenge).not.toHaveBeenCalled();
                });

                test('a join that was not a submit-only retry is unchanged: a missing marker means unlock, as ever', async () => {
                    const deps = retrying(null);
                    const res = await performJoin(invalid({ id: 2 }), 'tok', deps, 100);
                    expect(res.status).toBe('joined');
                    expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);
                });
            });

            describe('no eligible photo to submit', () => {
                test('coins already spent: reported as pending, not "no coins were charged", and the marker stays', async () => {
                    photoPicker.pickPhotosForChallenge.mockReturnValue([]);
                    const writeRaw = jest.fn();
                    const deps = retrying(MARKED, { joinStateStore: { readRaw: () => MARKED, writeRaw } });
                    const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: true });
                    expect(res).toMatchObject({ status: 'charged-pending-submit', cost: 100, reason: 'no-photo' });
                    expect(deps.submitToChallenge).not.toHaveBeenCalled();
                    expect(deps.coinsUnlock).not.toHaveBeenCalled();
                    expect(writeRaw).not.toHaveBeenCalled();
                });

                test('nothing spent yet: still "no eligible photo"', async () => {
                    photoPicker.pickPhotosForChallenge.mockReturnValue([]);
                    const deps = retrying(null);
                    expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).status).toBe(
                        'skipped-no-photo',
                    );
                });

                test('a free join with a stray marker is not turned into a charge that never happened', async () => {
                    photoPicker.pickPhotosForChallenge.mockReturnValue([]);
                    const deps = makeDeps({ joinStateStore: { readRaw: () => MARKED, writeRaw: jest.fn() } });
                    expect((await performJoin(invalid({ id: 2 }), 'tok', deps, 0)).status).toBe('skipped-no-photo');
                });
            });
        });

        test('a free challenge joins whatever was confirmed, and one that turned paid is not joined for free', async () => {
            expect((await joinChallengeSingle(2, 'tok', priced(0), { spendCoins: true, expectedCost: 0 })).status).toBe(
                'joined',
            );
            const turnedPaid = priced(40);
            expect(await joinChallengeSingle(2, 'tok', turnedPaid, { expectedCost: 0 })).toMatchObject({
                status: 'needs-confirm',
                cost: 40,
            });
            expect(untouched(turnedPaid)).toBe(true);
        });
    });
});

/**
 * Unlock markers belong to an account: one account's leftover marker must not turn another account's
 * join of the same challenge into a submit-only retry (that join would fail forever, unpaid).
 */
describe('unlock markers are kept per account', () => {
    const A = 'a'.repeat(32);
    const B = 'b'.repeat(32);
    const memberIdentity = require('../../src/ts/services/autoFill/memberIdentity') as typeof memberIdentityModule;

    const joiningAs = (
        member: string | null,
        store: ReturnType<typeof fileWith>,
        over: NonNullable<Parameters<typeof makeDeps>[0]> = {},
    ) =>
        makeDeps({
            getMemberChallenges: openList([{ id: 2, join_coins: 100, type: 'flash' }]),
            getBankroll: balance({ coins: 500 }),
            getCurrentMemberProfile: member === null ? undefined : jest.fn(async () => ({ id: member, userName: 'u' })),
            joinStateStore: store,
            ...over,
        });

    beforeEach(() => memberIdentity.__resetMemberIdCache());

    test("another account's marker does not make this account's join a submit-only retry: it pays, and keeps its own marker apart", async () => {
        const store = fileWith({ [`${A}:2`]: { unlockedAt: RECENT } });
        const deps = joiningAs(B, store, {
            submitToChallenge: double<'submitToChallenge'>(async () => ({ ok: false, raw: null })),
        });
        const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: true, expectedCost: 100 });
        // B is asked and charged as any first-time join; the submit failed, so B's own marker is left.
        expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);
        expect(res.status).toBe('charged-pending-submit');
        expect(Object.keys(store.read()).sort()).toEqual([`${A}:2`, `${B}:2`]);
    });

    test("a join that succeeds clears its own account's marker and leaves the other account's", async () => {
        const store = fileWith({ [`${A}:2`]: { unlockedAt: RECENT } });
        const deps = joiningAs(B, store);
        expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).status).toBe('joined');
        expect(Object.keys(store.read())).toEqual([`${A}:2`]);
    });

    test('the same account retries submit-only, as before', async () => {
        const store = fileWith({ [`${A}:2`]: { unlockedAt: RECENT } });
        const deps = joiningAs(A, store);
        const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: true, expectedCost: 40 });
        expect(res.status).toBe('joined');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
        expect(deps.getBankroll).not.toHaveBeenCalled();
        expect(store.read()).toEqual({});
    });

    test('a marker from before accounts were told apart still protects whoever is joining, and a submit that succeeds clears it', async () => {
        for (const member of [A, B]) {
            memberIdentity.__resetMemberIdCache();
            const store = fileWith({ '2': { unlockedAt: RECENT } });
            const deps = joiningAs(member, store);
            expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).status).toBe('joined');
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
            // The submit succeeding proves this account held the unlock.
            expect(store.read()).toEqual({});
        }
    });

    test('a bare marker is never cleared by a submit that fails, and is worded as an earlier payment record, not as no answer', async () => {
        const store = fileWith({ '2': { unlockedAt: RECENT } });
        const deps = joiningAs(A, store, {
            submitToChallenge: double<'submitToChallenge'>(async () => ({ ok: false, raw: null })),
        });
        const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: true });
        expect(res).toMatchObject({ status: 'charged-pending-submit', reason: 'earlier-payment' });
        expect(Object.keys(store.read())).toEqual(['2']);
    });

    describe('an unconfirmed payment is never settled by itself: it stands until a submit succeeds or the user forgets it', () => {
        const unconfirmed = () => ({ [`${A}:2`]: { unlockedAt: RECENT, unconfirmed: true } });
        const asking = (
            store: ReturnType<typeof fileWith>,
            coins: number | null,
            over: NonNullable<Parameters<typeof makeDeps>[0]> = {},
        ) => joiningAs(A, store, { getBankroll: balance(coins === null ? null : { coins }), ...over });
        const failingSubmit = double<'submitToChallenge'>(async () => ({ ok: false, raw: null }));

        test.each([500, 450, 400, null])(
            'whatever the balance is (%s), a manual join only submits, saying the payment is unconfirmed, and the claim stays',
            async (coins) => {
                const store = fileWith(unconfirmed());
                const deps = asking(store, coins, { submitToChallenge: failingSubmit });
                const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: true });
                expect(res).toMatchObject({ status: 'charged-pending-submit', reason: 'unconfirmed' });
                expect(store.read()).toEqual(unconfirmed());
                expect(deps.coinsUnlock).not.toHaveBeenCalled();
                expect(deps.getBankroll).not.toHaveBeenCalled();
            },
        );

        test('without consent to a price a manual join still only submits: nothing asks for a price it cannot take', async () => {
            const store = fileWith(unconfirmed());
            const deps = asking(store, 500);
            expect((await joinChallengeSingle(2, 'tok', deps)).status).toBe('joined');
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
            expect(store.read()).toEqual({});
        });

        test('with no photo to finish with, the unconfirmed payment is what the user is told, not "no photo"', async () => {
            photoPicker.pickPhotosForChallenge.mockReturnValue([]);
            const store = fileWith(unconfirmed());
            const deps = asking(store, 450);
            const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: true });
            expect(res).toMatchObject({ status: 'charged-pending-submit', reason: 'unconfirmed' });
            expect(store.read()).toEqual(unconfirmed());
        });

        test('the automatic pass submits it whatever the balance and budget now say, and never unlocks', async () => {
            const store = fileWith(unconfirmed());
            const deps = asking(store, 3);
            expect((await runJoinPass('tok', Date.now(), deps)).results).toEqual([{ id: 2, status: 'joined' }]);
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
            expect(deps.getBankroll).toHaveBeenCalledTimes(1); // the pass's own read, not a settling one
            expect(store.read()).toEqual({});
        });

        test('the automatic pass counts an unlock that got no answer against its budget and balance, without reporting it charged', async () => {
            settings.getEffectiveSetting.mockImplementation(
                (k) => ({ autoJoin: true, autoJoinMaxCoins: 150, autoJoinCycleCoinBudget: 150 })[k as string],
            );
            const store = fileWith({});
            const deps = asking(store, 500, {
                getMemberChallenges: openList([
                    { id: 2, join_coins: 100, type: 'flash' },
                    { id: 3, join_coins: 100, type: 'flash' },
                ]),
                coinsUnlock: double<'coinsUnlock'>(async () => ({ ok: false, raw: null, unclear: true })),
            });
            const res = await runJoinPass('tok', Date.now(), deps);
            expect(res.results).toEqual([
                { id: 2, status: 'charged-pending-submit' },
                { id: 3, status: 'skipped:over-cycle-budget' },
            ]);
            expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);
        });

        test('the automatic pass counts an unlock that got no answer against its balance too', async () => {
            settings.getEffectiveSetting.mockImplementation(
                (k) => ({ autoJoin: true, autoJoinMaxCoins: 150, autoJoinCycleCoinBudget: 1000 })[k as string],
            );
            const store = fileWith({});
            const deps = asking(store, 150, {
                getMemberChallenges: openList([
                    { id: 2, join_coins: 100, type: 'flash' },
                    { id: 3, join_coins: 100, type: 'flash' },
                ]),
                coinsUnlock: double<'coinsUnlock'>(async () => ({ ok: false, raw: null, unclear: true })),
            });
            const res = await runJoinPass('tok', Date.now(), deps);
            expect(res.results).toEqual([
                { id: 2, status: 'charged-pending-submit' },
                { id: 3, status: 'skipped:insufficient-coins' },
            ]);
            expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);
        });
    });

    describe('the claims of challenges that are no longer open are dropped', () => {
        const OLD = { unlockedAt: RECENT - 7 * 60 * 60 * 1000 };
        const freeOpen = (...ids: number[]) => openList(ids.map((id) => ({ id, join_coins: 0, type: 'flash' })));
        const claims = () => ({
            [`${A}:7`]: OLD, // closed: goes
            [`${A}:12`]: OLD, // still open: stays
            [`${A}:99`]: { unlockedAt: Date.now() }, // closed, but too young to tell from a list read a moment ago
            [`${A}:98`]: { unlockedAt: 'garbage' }, // no age to judge by
            [`${A}:97`]: 'not even an object', // nothing to judge by either
            [`${B}:9`]: OLD, // another account's: this account's list says nothing about it
            '8': OLD, // a bare one from before accounts were told apart: may be another account's
        });

        test("the automatic pass drops this account's own old closed claims from a successful list, and only those", async () => {
            const store = fileWith(claims());
            const deps = joiningAs(A, store, { getMemberChallenges: freeOpen(5, 12) });
            await runJoinPass('tok', Date.now(), deps);
            expect(Object.keys(store.read()).sort()).toEqual(
                [`${A}:12`, `${A}:97`, `${A}:98`, `${A}:99`, `${B}:9`, '8'].sort(),
            );
        });

        test('a manual join reads the same list and drops the same claims', async () => {
            const store = fileWith(claims());
            const deps = joiningAs(A, store, { getMemberChallenges: freeOpen(5, 12) });
            expect((await joinChallengeSingle(5, 'tok', deps)).status).toBe('joined');
            expect(Object.keys(store.read())).not.toContain(`${A}:7`);
            expect(Object.keys(store.read())).toContain(`${A}:12`);
        });

        test('an empty list, a failed one and an account that cannot be told prune nothing', async () => {
            for (const [list, member] of [
                [openList([]), A],
                [double<'getMemberChallenges'>(async () => null), A],
                [freeOpen(5), null],
            ] as const) {
                memberIdentity.__resetMemberIdCache();
                const store = fileWith(claims());
                const deps = joiningAs(member, store, {
                    getMemberChallenges: list,
                    ...(member === null ? { getCurrentMemberProfile: jest.fn(async () => null) } : {}),
                });
                await runJoinPass('tok', Date.now(), deps);
                expect(store.writeRaw).not.toHaveBeenCalled();
            }
        });

        test("with no accounts told apart (no profile read wired in) the bare claims are this one's", async () => {
            const store = fileWith({ '7': OLD, '12': OLD });
            const deps = joiningAs(null, store, { getMemberChallenges: freeOpen(5, 12) });
            await runJoinPass('tok', Date.now(), deps);
            expect(Object.keys(store.read())).toEqual(['12']);
        });

        describe("a claim older than 30 days goes, whoever's it is and whatever the list says", () => {
            const DAY = 24 * 60 * 60 * 1000;
            const aged = (days: number) => ({ unlockedAt: RECENT - days * DAY });

            test("bare ones, other accounts' and its own, of a challenge no longer open (its own of an open one stays), younger ones stay", async () => {
                const store = fileWith({
                    '8': aged(31),
                    [`${B}:9`]: aged(31),
                    [`${A}:12`]: aged(31),
                    [`${B}:13`]: aged(29),
                    '14': aged(29),
                    [`${A}:15`]: { note: 'no age to judge by' },
                });
                const deps = joiningAs(A, store, { getMemberChallenges: freeOpen(5, 12) });
                await runJoinPass('tok', Date.now(), deps);
                // Its own claim of a challenge that is still open stays: age alone never removes it.
                expect(Object.keys(store.read()).sort()).toEqual([`${A}:12`, `${A}:15`, `${B}:13`, '14'].sort());
            });

            test('an account that cannot be told prunes by age alone', async () => {
                const store = fileWith({ '8': aged(31), [`${B}:9`]: aged(31), [`${B}:13`]: OLD });
                const deps = joiningAs(A, store, {
                    getMemberChallenges: freeOpen(5),
                    getCurrentMemberProfile: jest.fn(async () => null),
                });
                await runJoinPass('tok', Date.now(), deps);
                expect(Object.keys(store.read())).toEqual([`${B}:13`]);
            });
        });

        test('an empty open list prunes nothing, through a manual join too', async () => {
            const store = fileWith(claims());
            const deps = joiningAs(A, store, { getMemberChallenges: openList([]) });
            expect((await joinChallengeSingle(7, 'tok', deps)).status).toBe('unavailable');
            expect(store.writeRaw).not.toHaveBeenCalled();
        });

        test('a file that became unreadable between the look and the rewrite is left alone', async () => {
            const reads = [JSON.stringify(claims())];
            const writeRaw = jest.fn<void, [string]>();
            const deps = joiningAs(
                A,
                invalid<ReturnType<typeof fileWith>>({
                    readRaw: () => (reads.length > 0 ? reads.shift()! : 'not json{{'),
                    writeRaw,
                }),
                { getMemberChallenges: freeOpen(5) },
            );
            // pruneClosedClaims' own look is the first read the pass makes of it (the free join reads none).
            await runJoinPass('tok', Date.now(), deps);
            expect(writeRaw).not.toHaveBeenCalled();
        });

        test('nothing stored, nothing written', async () => {
            const store = fileWith({});
            const deps = joiningAs(A, store, { getMemberChallenges: freeOpen(5) });
            await runJoinPass('tok', Date.now(), deps);
            expect(store.writeRaw).not.toHaveBeenCalled();
        });

        test.each([new Error('read-only'), new Error('')])(
            'a store that cannot be written is logged, and the pass goes on (%s)',
            async (failure) => {
                const logged: LoggerMock = invalid(require('../../src/ts/logger'));
                logged.withCategory().warning.mockClear();
                const stored = JSON.stringify(claims());
                const deps = joiningAs(
                    A,
                    invalid<ReturnType<typeof fileWith>>({
                        readRaw: () => stored,
                        writeRaw: () => {
                            throw failure;
                        },
                    }),
                    { getMemberChallenges: freeOpen(5) },
                );
                expect((await runJoinPass('tok', Date.now(), deps)).results).toEqual([{ id: 5, status: 'joined' }]);
                expect(
                    logged
                        .withCategory()
                        .warning.mock.calls.some(([msg]) =>
                            String(msg).startsWith('could not prune the unlock markers:'),
                        ),
                ).toBe(true);
            },
        );
    });

    describe('the balance before a payment is kept in its claim for the user to compare, and nothing decides on it', () => {
        const noAnswer = double<'coinsUnlock'>(async () => ({ ok: false, raw: null, unclear: true }));
        const failingSubmit = double<'submitToChallenge'>(async () => ({ ok: false, raw: null }));

        test('a manual join records the balance its own affordability read gave: no read of its own, and it is shown back', async () => {
            const store = fileWith({});
            const deps = joiningAs(A, store, { coinsUnlock: noAnswer });
            const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: true });
            expect(res).toMatchObject({ status: 'charged-pending-submit', reason: 'unconfirmed', coinsBefore: 500 });
            expect(deps.getBankroll).toHaveBeenCalledTimes(1);
            expect(store.read()).toEqual({
                [`${A}:2`]: { unlockedAt: expect.any(Number), coinsBefore: 500, unconfirmed: true },
            });
        });

        test('the next attempt shows the recorded balance again, and reads none', async () => {
            const store = fileWith({ [`${A}:2`]: { unlockedAt: RECENT, unconfirmed: true, coinsBefore: 500 } });
            const deps = joiningAs(A, store, { submitToChallenge: failingSubmit, getBankroll: balance({ coins: 3 }) });
            const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: true });
            expect(res).toMatchObject({ status: 'charged-pending-submit', reason: 'unconfirmed', coinsBefore: 500 });
            expect(deps.getBankroll).not.toHaveBeenCalled();
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
        });

        test('the automatic pass records the balance it already holds', async () => {
            const store = fileWith({});
            const deps = joiningAs(A, store, { coinsUnlock: noAnswer });
            await runJoinPass('tok', Date.now(), deps);
            expect(store.read()).toEqual({
                [`${A}:2`]: { unlockedAt: expect.any(Number), coinsBefore: 500, unconfirmed: true },
            });
            expect(deps.getBankroll).toHaveBeenCalledTimes(1);
        });

        test('a payment that was answered keeps the number too, but is worded as charged: it is no unconfirmed payment', async () => {
            const store = fileWith({});
            const deps = joiningAs(A, store, { submitToChallenge: failingSubmit });
            const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: true });
            expect(res).toMatchObject({ status: 'charged-pending-submit', reason: undefined, coinsBefore: undefined });
            expect(store.read()[`${A}:2`]).toEqual({ unlockedAt: expect.any(Number), coinsBefore: 500 });
        });

        test('a balance that was not known is not invented, and a claim from before this has none', async () => {
            const store = fileWith({});
            const deps = joiningAs(A, store, { coinsUnlock: noAnswer });
            const direct = await performJoin(invalid({ id: 2, join_coins: 100 }), 'tok', deps, 100);
            expect(direct.coinsBefore).toBeUndefined();
            expect(store.read()[`${A}:2`]).toEqual({ unlockedAt: expect.any(Number), unconfirmed: true });
            const old = fileWith({ [`${A}:2`]: { unlockedAt: RECENT, unconfirmed: true } });
            const res = await joinChallengeSingle(2, 'tok', joiningAs(A, old, { submitToChallenge: failingSubmit }), {
                spendCoins: true,
            });
            expect(res.coinsBefore).toBeUndefined();
        });
    });

    describe('a submit that continues on a claim holds the unlock lock, and the claim is cleared under it too', () => {
        const release = jest.fn();
        const stateRelease = jest.fn();
        // The answers are for the challenge locks, in turn; the lock of the claims file is always had.
        const lockOf = (answers: boolean[]) =>
            jest.fn((id: string | number) =>
                id === 'joinstate' ? { ok: true, release: stateRelease } : { ok: answers.shift() ?? true, release },
            );
        const challengeLocks = (acquire: ReturnType<typeof lockOf>) =>
            acquire.mock.calls.filter(([id]) => id !== 'joinstate');
        // Old enough to be pruned when its challenge is no longer open, and nowhere near 30 days.
        const OLD_AT = RECENT - 7 * 60 * 60 * 1000;

        beforeEach(() => {
            release.mockClear();
            stateRelease.mockClear();
        });

        test('a lock another process holds submits nothing: busy', async () => {
            const store = fileWith({ [`${A}:2`]: { unlockedAt: RECENT } });
            const deps = joiningAs(A, store, { acquireUnlockLock: lockOf([false]) });
            expect(await joinChallengeSingle(2, 'tok', deps)).toMatchObject({ status: 'busy' });
            expect(deps.submitToChallenge).not.toHaveBeenCalled();
            expect(store.read()).toEqual({ [`${A}:2`]: { unlockedAt: RECENT } });
        });

        test('the claim is read again under the lock: gone by then (another process forgot it), nothing is submitted', async () => {
            const claim = JSON.stringify({ [`${A}:2`]: { unlockedAt: RECENT } });
            let reads = 0;
            const store = invalid<ReturnType<typeof fileWith>>({
                // The caller's and the join's own read see it; the one under the lock does not.
                readRaw: () => (++reads <= 2 ? claim : '{}'),
                writeRaw: jest.fn(),
            });
            const deps = joiningAs(A, store, { acquireUnlockLock: lockOf([]) });
            expect(await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).toMatchObject({
                status: 'failed-no-charge',
            });
            expect(deps.submitToChallenge).not.toHaveBeenCalled();
            expect(release).toHaveBeenCalledTimes(1);
        });

        test('submitting and clearing happen under one lock, which is let go', async () => {
            const store = fileWith({ [`${A}:2`]: { unlockedAt: RECENT } });
            const acquire = lockOf([]);
            const deps = joiningAs(A, store, { acquireUnlockLock: acquire });
            expect((await joinChallengeSingle(2, 'tok', deps)).status).toBe('joined');
            expect(challengeLocks(acquire)).toHaveLength(1);
            expect(release).toHaveBeenCalledTimes(1);
            expect(stateRelease).toHaveBeenCalled();
            expect(store.read()).toEqual({});
        });

        test('after a fresh unlock the claim is cleared under the lock again; a lock held then leaves it for the pruning', async () => {
            const free = fileWith({});
            expect(
                (
                    await joinChallengeSingle(2, 'tok', joiningAs(A, free, { acquireUnlockLock: lockOf([]) }), {
                        spendCoins: true,
                    })
                ).status,
            ).toBe('joined');
            expect(free.read()).toEqual({});
            memberIdentity.__resetMemberIdCache();
            const held = fileWith({});
            // The unlock section gets its lock, the clearing after the submit does not.
            const deps = joiningAs(A, held, { acquireUnlockLock: lockOf([true, false]) });
            expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).status).toBe('joined');
            expect(Object.keys(held.read())).toEqual([`${A}:2`]);
        });

        test('pruning leaves a challenge whose lock another process holds, and says nothing of what it did not drop', async () => {
            const logged: LoggerMock = invalid(require('../../src/ts/logger'));
            logged.withCategory().debug.mockClear();
            const store = fileWith({ [`${A}:7`]: { unlockedAt: OLD_AT }, [`${A}:8`]: { unlockedAt: OLD_AT } });
            const acquire = jest.fn((id: string | number) => ({ ok: String(id) !== '7', release }));
            const deps = joiningAs(A, store, {
                getMemberChallenges: openList([{ id: 5, join_coins: 0, type: 'flash' }]),
                acquireUnlockLock: acquire,
            });
            await runJoinPass('tok', Date.now(), deps);
            expect(Object.keys(store.read())).toContain(`${A}:7`);
            expect(Object.keys(store.read())).not.toContain(`${A}:8`);
            expect(logged.withCategory().debug).toHaveBeenCalledWith(
                'dropped 1 unlock claim(s) that are no longer needed',
                null,
            );
        });

        test('a prune whose write fails does not claim to have dropped anything', async () => {
            const logged: LoggerMock = invalid(require('../../src/ts/logger'));
            logged.withCategory().debug.mockClear();
            const stored = JSON.stringify({ [`${A}:7`]: { unlockedAt: OLD_AT } });
            const deps = joiningAs(
                A,
                invalid<ReturnType<typeof fileWith>>({
                    readRaw: () => stored,
                    writeRaw: () => {
                        throw new Error('read-only');
                    },
                }),
                { getMemberChallenges: openList([{ id: 5, join_coins: 0, type: 'flash' }]) },
            );
            await runJoinPass('tok', Date.now(), deps);
            expect(logged.withCategory().warning).toHaveBeenCalledWith(
                'could not prune the unlock markers: read-only',
                null,
            );
            expect(logged.withCategory().debug).not.toHaveBeenCalledWith(
                expect.stringContaining('dropped'),
                expect.anything(),
            );
        });
    });

    describe("the claims file is changed under its own lock: two processes never drop each other's change", () => {
        const unlock = jest.fn();
        let clock = 0;

        beforeEach(() => {
            clock = Date.now();
            jest.spyOn(Date, 'now').mockImplementation(() => clock);
            // Waiting moves the clock instead of the process: the bounded wait is then measured in steps.
            jest.spyOn(Atomics, 'wait').mockImplementation(() => {
                clock += 10;
                return 'timed-out';
            });
            unlock.mockClear();
        });

        afterEach(() => {
            jest.restoreAllMocks();
        });

        const lockedFor = (busyFor: number) => {
            let refusals = busyFor;
            return jest.fn((id: string | number) => ({
                ok: id !== 'joinstate' || refusals-- <= 0,
                release: unlock,
            }));
        };

        test('a lock held a moment is waited for, and the claim is then recorded', async () => {
            const store = fileWith({});
            const deps = joiningAs(A, store, { acquireUnlockLock: lockedFor(3) });
            expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).status).toBe('joined');
            expect(Atomics.wait).toHaveBeenCalledTimes(3);
        });

        test('a lock that stays held for longer than the wait: the claim cannot be written, so no coins are spent', async () => {
            const store = fileWith({});
            const deps = joiningAs(A, store, { acquireUnlockLock: lockedFor(Number.POSITIVE_INFINITY) });
            expect(await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).toMatchObject({
                status: 'failed-no-charge',
            });
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
            expect(store.writeRaw).not.toHaveBeenCalled();
            // About half a second of waiting, in small steps.
            const waited = jest.mocked(Atomics.wait).mock.calls.length;
            expect(waited).toBeGreaterThanOrEqual(40);
            expect(waited).toBeLessThanOrEqual(60);
        });

        test('what it could not change it says, and a claim it could not clear stays', async () => {
            const logged: LoggerMock = invalid(require('../../src/ts/logger'));
            const store = fileWith({ [`${A}:2`]: { unlockedAt: RECENT } });
            // The claims file is locked from the start: the submit goes on the claim, but its removal cannot.
            const deps = joiningAs(A, store, { acquireUnlockLock: lockedFor(Number.POSITIVE_INFINITY) });
            expect((await joinChallengeSingle(2, 'tok', deps)).status).toBe('joined');
            expect(Object.keys(store.read())).toEqual([`${A}:2`]);
            expect(logged.withCategory().warning).toHaveBeenCalledWith(
                'could not clear unlock marker for 2: join-state is locked by another process — nothing written',
                null,
            );
        });

        // Two processes, as far as one file can tell: a lock registry they share, and a store they both write.
        const sharedLocks = () => {
            const held = new Set<string>();
            return jest.fn((id: string | number) => {
                const key = String(id);
                if (held.has(key)) return { ok: false, release: () => {} };
                held.add(key);
                return { ok: true, release: () => held.delete(key) };
            });
        };

        test('two writers contend for the file: the one that waits does not write over the other, and both claims end up kept', () => {
            const locks = sharedLocks();
            const state = fileWith({});
            const first = joiningAs(A, state, { acquireUnlockLock: locks });
            const second = joiningAs(A, state, { acquireUnlockLock: locks });
            let secondTried: boolean | null = null;
            const read = state.readRaw;
            // The second process comes in while the first is between its read and its write.
            let once = true;
            state.readRaw = () => {
                const raw = read();
                if (once) {
                    once = false;
                    secondTried = markUnlocked(second, 8, A, null);
                }
                return raw;
            };
            expect(markUnlocked(first, 7, A, null)).toBe(true);
            // The lock held the second out for its whole wait: it records nothing (and so spends nothing).
            expect(secondTried).toBe(false);
            expect(Object.keys(state.read())).toEqual([`${A}:7`]);
            // Its retry, once the file is free, keeps what the first wrote.
            expect(markUnlocked(second, 8, A, null)).toBe(true);
            expect(Object.keys(state.read()).sort()).toEqual([`${A}:7`, `${A}:8`]);
        });

        test('without the lock the same interleaving loses a claim: which is what the lock is for', () => {
            const state = fileWith({});
            const first = joiningAs(A, state);
            const second = joiningAs(A, state);
            const read = state.readRaw;
            let once = true;
            state.readRaw = () => {
                const raw = read();
                if (once) {
                    once = false;
                    markUnlocked(second, 8, A, null);
                }
                return raw;
            };
            markUnlocked(first, 7, A, null);
            expect(Object.keys(state.read())).toEqual([`${A}:7`]);
        });

        test('a claim another holder recorded since the join looked is never overwritten: no record, no spend', async () => {
            const claim = JSON.stringify({ [`${A}:2`]: { unlockedAt: RECENT, unconfirmed: true } });
            // The caller's, the join's own and the unlock section's reads see none; the write's read sees the other's.
            let reads = 0;
            const writeRaw = jest.fn();
            const store = invalid<ReturnType<typeof fileWith>>({
                readRaw: () => (++reads <= 3 ? '{}' : claim),
                writeRaw,
            });
            const deps = joiningAs(A, store);
            expect(await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).toMatchObject({
                status: 'failed-no-charge',
            });
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
            expect(writeRaw).not.toHaveBeenCalled();
        });

        test('a second record for the same challenge is refused, own or bare, whoever holds the lock', () => {
            const own = fileWith({ [`${A}:2`]: { unlockedAt: RECENT } });
            expect(markUnlocked(joiningAs(A, own), 2, A, null)).toBe(false);
            const bare = fileWith({ '2': { unlockedAt: RECENT } });
            expect(markUnlocked(joiningAs(A, bare), 2, A, null)).toBe(false);
            const other = fileWith({ [`${B}:2`]: { unlockedAt: RECENT } });
            expect(markUnlocked(joiningAs(A, other), 2, A, null)).toBe(true);
        });

        describe('a refused unlock whose claim cannot be removed does not leave it looking confirmed', () => {
            const refusal = { ok: false, raw: { success: false } };
            const attempt = (busyForWaits: number) => {
                const store = fileWith({});
                const waitsSoFar = () => jest.mocked(Atomics.wait).mock.calls.length;
                let armed = false;
                const deps = joiningAs(A, store, {
                    // The claims file is held by someone else from the moment the unlock is refused, for a while.
                    acquireUnlockLock: jest.fn((id: string | number) => ({
                        ok: id !== 'joinstate' || !armed || waitsSoFar() >= busyForWaits,
                        release: unlock,
                    })),
                    coinsUnlock: double<'coinsUnlock'>(async () => {
                        armed = true;
                        return refusal;
                    }),
                });
                return { store, deps };
            };

            test('it is tried again: a lock that frees up in time lets it go', async () => {
                const { store, deps } = attempt(110);
                expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).status).toBe(
                    'failed-no-charge',
                );
                expect(store.read()).toEqual({});
            });

            test('and when it never does, it is flagged unconfirmed instead, so it can be forgotten', async () => {
                const logged: LoggerMock = invalid(require('../../src/ts/logger'));
                const { store, deps } = attempt(170);
                expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).status).toBe(
                    'failed-no-charge',
                );
                expect(store.read()).toEqual({ [`${A}:2`]: expect.objectContaining({ unconfirmed: true }) });
                expect(logged.withCategory().error).toHaveBeenCalledWith(
                    expect.stringContaining('it is flagged as unconfirmed, so it can be forgotten'),
                    null,
                );
            });

            test('and when it cannot be flagged either, that is logged', async () => {
                const logged: LoggerMock = invalid(require('../../src/ts/logger'));
                const { store, deps } = attempt(Number.POSITIVE_INFINITY);
                expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).status).toBe(
                    'failed-no-charge',
                );
                expect(Object.keys(store.read())).toEqual([`${A}:2`]);
                expect(logged.withCategory().error).toHaveBeenCalledWith(
                    expect.stringContaining('it could not be flagged either'),
                    null,
                );
            });
        });

        test('a claims file that is locked when the user forgets is "busy", not "unreadable"', async () => {
            const store = fileWith({ [`${A}:2`]: { unlockedAt: RECENT, unconfirmed: true } });
            const deps = joiningAs(A, store, { acquireUnlockLock: lockedFor(Number.POSITIVE_INFINITY) });
            expect(await forgetUnconfirmedPayment(2, 'tok', deps)).toEqual({ status: 'busy', challengeId: 2 });
            expect(store.writeRaw).not.toHaveBeenCalled();
        });

        test('every lock it takes is let go, also when the change fails', async () => {
            const store = invalid<ReturnType<typeof fileWith>>({
                readRaw: () => '{}',
                writeRaw: () => {
                    throw new Error('read-only');
                },
            });
            const deps = joiningAs(A, store, { acquireUnlockLock: lockedFor(0) });
            await joinChallengeSingle(2, 'tok', deps, { spendCoins: true });
            expect(unlock).toHaveBeenCalled();
            expect(jest.mocked(deps.acquireUnlockLock!).mock.calls.length).toBe(unlock.mock.calls.length);
        });
    });

    describe('the user forgetting an unconfirmed payment', () => {
        const forgetting = (member: string | null, store: ReturnType<typeof fileWith>, over: Partial<JoinDeps> = {}) =>
            joiningAs(member, store, over);

        test("this account's unconfirmed claim goes, and the next join asks for its price", async () => {
            const store = fileWith({
                [`${A}:2`]: { unlockedAt: RECENT, unconfirmed: true },
                [`${B}:2`]: { unlockedAt: RECENT, unconfirmed: true },
            });
            const deps = forgetting(A, store);
            expect(await forgetUnconfirmedPayment(2, 'tok', deps)).toEqual({ status: 'forgotten', challengeId: 2 });
            expect(Object.keys(store.read())).toEqual([`${B}:2`]);
            expect(await joinChallengeSingle(2, 'tok', deps)).toEqual({
                status: 'needs-confirm',
                challengeId: 2,
                cost: 100,
            });
        });

        test("a bare claim from before accounts were told apart is never forgotten: it may be another account's", async () => {
            // However alone it stands in the store, nothing on this device can tell whose it is.
            const alone = fileWith({ '2': { unlockedAt: RECENT } });
            expect(await forgetUnconfirmedPayment(2, 'tok', forgetting(A, alone))).toEqual({
                status: 'legacy-record',
                challengeId: 2,
            });
            expect(alone.writeRaw).not.toHaveBeenCalled();
            memberIdentity.__resetMemberIdCache();
            const crowded = fileWith({ '2': { unlockedAt: RECENT }, [`${B}:5`]: { unlockedAt: RECENT } });
            expect((await forgetUnconfirmedPayment(2, 'tok', forgetting(A, crowded))).status).toBe('legacy-record');
            expect(crowded.writeRaw).not.toHaveBeenCalled();
        });

        test("never a claim known to have been charged, and never a bare one behind the account's own confirmed claim", async () => {
            const own = fileWith({ [`${A}:2`]: { unlockedAt: RECENT }, '2': { unlockedAt: RECENT } });
            expect((await forgetUnconfirmedPayment(2, 'tok', forgetting(A, own))).status).toBe('nothing-to-forget');
            expect(own.writeRaw).not.toHaveBeenCalled();
            const empty = fileWith({});
            expect((await forgetUnconfirmedPayment(2, 'tok', forgetting(A, empty))).status).toBe('nothing-to-forget');
        });

        test('an account that cannot be told, no token, and an unreadable file change nothing', async () => {
            const store = fileWith({ [`${A}:2`]: { unlockedAt: RECENT, unconfirmed: true } });
            const unknown = forgetting(null, store, { getCurrentMemberProfile: jest.fn(async () => null) });
            expect((await forgetUnconfirmedPayment(2, 'tok', unknown)).status).toBe('account-unknown');
            expect((await forgetUnconfirmedPayment(2, '', forgetting(A, store))).status).toBe('not-authenticated');
            memberIdentity.__resetMemberIdCache();
            const corrupt = { readRaw: () => 'not json{{', writeRaw: jest.fn<void, [string]>() };
            const deps = forgetting(A, invalid<ReturnType<typeof fileWith>>(corrupt));
            expect((await forgetUnconfirmedPayment(2, 'tok', deps)).status).toBe('unreadable');
            expect(corrupt.writeRaw).not.toHaveBeenCalled();
            expect(store.writeRaw).not.toHaveBeenCalled();
        });

        test('under the unlock lock: a held lock or a join under way is busy, and the lock is let go afterwards', async () => {
            const store = fileWith({ [`${A}:2`]: { unlockedAt: RECENT, unconfirmed: true } });
            const release = jest.fn();
            const held = forgetting(A, store, { acquireUnlockLock: () => ({ ok: false, release }) });
            expect((await forgetUnconfirmedPayment(2, 'tok', held)).status).toBe('busy');
            inFlight.add('2');
            expect((await forgetUnconfirmedPayment(2, 'tok', forgetting(A, store))).status).toBe('busy');
            inFlight.delete('2');
            const free = forgetting(A, store, { acquireUnlockLock: () => ({ ok: true, release }) });
            expect((await forgetUnconfirmedPayment(2, 'tok', free)).status).toBe('forgotten');
            // The challenge's lock, and the claims file's under it.
            expect(release).toHaveBeenCalledTimes(2);
        });

        test('with no store (mock mode) there is nothing to forget', async () => {
            const deps = forgetting(A, fileWith({}), { joinStateStore: null });
            expect((await forgetUnconfirmedPayment(2, 'tok', deps)).status).toBe('nothing-to-forget');
        });

        test('an id with a colon in it cannot name another record: it forgets nothing, and a confirmed claim stays', async () => {
            const store = fileWith({
                [`${A}:123`]: { unlockedAt: RECENT },
                [`${A}:2`]: { unlockedAt: RECENT, unconfirmed: true },
            });
            for (const crafted of [`${A}:123`, '555:123', '2:2']) {
                expect((await forgetUnconfirmedPayment(crafted, 'tok', forgetting(A, store))).status).toBe(
                    'nothing-to-forget',
                );
            }
            expect(store.writeRaw).not.toHaveBeenCalled();
            // The bare-key fallback never reads a key with a colon as a bare claim either.
            expect(findClaim({ '555:123': { unlockedAt: RECENT } }, '555:123', A)).toBeNull();
        });

        test('a claim whose record is no object still reads as a claim: confirmed, with no balance', async () => {
            expect(findClaim({ [`${A}:2`]: 'not an object' }, 2, A)).toEqual({
                key: `${A}:2`,
                unconfirmed: false,
                legacy: false,
                coinsBefore: null,
            });
        });

        test('an unconfirmed claim of the account is forgotten even with other accounts around: it is its own', async () => {
            const store = fileWith({
                [`${A}:2`]: { unlockedAt: RECENT, unconfirmed: true },
                [`${B}:5`]: { unlockedAt: RECENT },
            });
            expect((await forgetUnconfirmedPayment(2, 'tok', forgetting(A, store))).status).toBe('forgotten');
            expect(Object.keys(store.read())).toEqual([`${B}:5`]);
        });

        test('its own unconfirmed claim and a bare one for the same challenge: only its own goes, then the bare one stands alone', async () => {
            const store = fileWith({
                [`${A}:2`]: { unlockedAt: RECENT, unconfirmed: true },
                '2': { unlockedAt: RECENT },
            });
            expect((await forgetUnconfirmedPayment(2, 'tok', forgetting(A, store))).status).toBe('forgotten');
            expect(Object.keys(store.read())).toEqual(['2']);
            expect(findClaim(store.read(), 2, A)).toMatchObject({ legacy: true });
        });

        test('what it logs about the challenge has no line break to forge a log line with', async () => {
            const logged: LoggerMock = invalid(require('../../src/ts/logger'));
            const deps = forgetting(A, fileWith({}), { getCurrentMemberProfile: jest.fn(async () => null) });
            await forgetUnconfirmedPayment('7\nforged line', 'tok', deps);
            const lines = logged.withCategory().warning.mock.calls.map(([msg]) => String(msg));
            expect(lines.some((line) => line.includes('7 forged line'))).toBe(true);
            expect(lines.some((line) => line.includes('\n'))).toBe(false);
        });
    });

    test('a new claim is written under the account that makes it', async () => {
        const store = fileWith({});
        const deps = joiningAs(A, store, {
            submitToChallenge: double<'submitToChallenge'>(async () => ({ ok: false, raw: null })),
        });
        await joinChallengeSingle(2, 'tok', deps, { spendCoins: true });
        expect(Object.keys(store.read())).toEqual([`${A}:2`]);
    });

    test('a failed unlock gives the claim back, and only its own', async () => {
        const store = fileWith({ [`${A}:2`]: { unlockedAt: RECENT } });
        const deps = joiningAs(B, store, {
            coinsUnlock: double<'coinsUnlock'>(async () => ({ ok: false, raw: { success: false } })),
        });
        expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).status).toBe('failed-no-charge');
        expect(Object.keys(store.read())).toEqual([`${A}:2`]);
    });

    describe('a free join leaves markers alone, a paid one clears only its own', () => {
        const free = (store: ReturnType<typeof fileWith>) =>
            makeDeps({
                getMemberChallenges: openList([{ id: 2, join_coins: 0, type: 'flash' }]),
                getCurrentMemberProfile: jest.fn(async () => ({ id: B, userName: 'u' })),
                joinStateStore: store,
            });

        test("another account's bare marker survives a free join of the same challenge", async () => {
            // Left before accounts were told apart, by an account that paid and has its submit still to do.
            const store = fileWith({ '2': { unlockedAt: RECENT } });
            expect((await joinChallengeSingle(2, 'tok', free(store), { spendCoins: false })).status).toBe('joined');
            expect(Object.keys(store.read())).toEqual(['2']);
            expect(store.writeRaw).not.toHaveBeenCalled();
        });

        test('and a keyed one too', async () => {
            const store = fileWith({ [`${A}:2`]: { unlockedAt: RECENT } });
            await joinChallengeSingle(2, 'tok', free(store), { spendCoins: false });
            expect(Object.keys(store.read())).toEqual([`${A}:2`]);
        });

        test("a paid join that finished with coins it found spent removes the account's own marker, never a bare one", async () => {
            const own = fileWith({ [`${B}:2`]: { unlockedAt: RECENT }, '2': { unlockedAt: RECENT } });
            const deps = joiningAs(B, own);
            expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).status).toBe('joined');
            expect(Object.keys(own.read())).toEqual(['2']);
        });

        test('a paid join with no account to key by (no profile read wired in) clears the bare marker it knows', async () => {
            const bare = fileWith({ '2': { unlockedAt: RECENT } });
            const deps = joiningAs(null, bare);
            expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).status).toBe('joined');
            expect(bare.read()).toEqual({});
        });
    });

    describe('a paid join whose account cannot be identified does nothing paid', () => {
        const unidentified = (kind: 'null' | 'throws', store: ReturnType<typeof fileWith>) =>
            joiningAs(null, store, {
                getCurrentMemberProfile:
                    kind === 'null'
                        ? jest.fn(async () => null)
                        : jest.fn(async () => {
                              throw new Error('down');
                          }),
            });

        test.each([['null' as const], ['throws' as const]])(
            'the profile read answering with %s: no unlock, no submit, no marker written or relied on, and "no coins were charged" is true',
            async (kind) => {
                for (const marker of [{}, { [`${A}:2`]: { unlockedAt: RECENT } }, { '2': { unlockedAt: RECENT } }]) {
                    memberIdentity.__resetMemberIdCache();
                    const store = fileWith(marker);
                    const deps = unidentified(kind, store);
                    const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: true, expectedCost: 100 });
                    expect(res).toMatchObject({ status: 'failed-no-charge', cost: 100, reason: 'account-unknown' });
                    expect(deps.coinsUnlock).not.toHaveBeenCalled();
                    expect(deps.submitToChallenge).not.toHaveBeenCalled();
                    expect(deps.getBankroll).not.toHaveBeenCalled();
                    expect(store.writeRaw).not.toHaveBeenCalled();
                }
            },
        );

        test('the join itself (the auto pass reaches it directly) refuses the same way', async () => {
            const store = fileWith({});
            const deps = unidentified('null', store);
            expect(await performJoin(invalid({ id: 2 }), 'tok', deps, 100)).toEqual({
                status: 'failed-no-charge',
                charged: 0,
                reason: 'account-unknown',
            });
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
            expect(store.writeRaw).not.toHaveBeenCalled();
        });

        test('a free join does not need to know the account', async () => {
            const store = fileWith({});
            const deps = unidentified('null', store);
            deps.getMemberChallenges = openList([{ id: 2, join_coins: 0, type: 'flash' }]);
            expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: false })).status).toBe('joined');
        });

        test('with no profile read wired in (the mock, a bare double) the account is not asked for: markers are bare', async () => {
            const store = fileWith({});
            const deps = joiningAs(null, store, {
                submitToChallenge: double<'submitToChallenge'>(async () => ({ ok: false })),
            });
            const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: true });
            expect(res.status).toBe('charged-pending-submit');
            expect(Object.keys(store.read())).toEqual(['2']);
        });

        test('with no marker store (mock mode) a paid join works whoever it is', async () => {
            const deps = joiningAs(null, fileWith({}), {
                joinStateStore: null,
                getCurrentMemberProfile: jest.fn(async () => null),
            });
            expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).status).toBe('joined');
            expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);
        });

        test("markers that merely end in the challenge id are not that challenge's", async () => {
            const store = fileWith({
                [`${A}:12`]: { unlockedAt: RECENT },
                [`${A}:22`]: { unlockedAt: RECENT },
                '12': { unlockedAt: RECENT },
            });
            const deps = joiningAs(A, store);
            expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: true, expectedCost: 40 })).status).toBe(
                'needs-confirm',
            );
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
        });
    });
});

/**
 * Join timing from a rule matched on the candidate's class (photo count here):
 * the rule's window overrides the global one, and the percent-elapsed anchor
 * replaces the hours window rather than intersecting with it.
 */
describe('runJoinPass \u2014 join timing from class rules', () => {
    const HOUR = 3600;
    const NOW_MS = 1_700_000_000_000;
    const NOW_SEC = NOW_MS / 1000;
    // A 24h challenge that opened 20h ago: 83% elapsed, 4h left.
    const candidate = (over = {}) => ({
        id: 1,
        join_coins: 0,
        type: 'default',
        title: 'Seaside',
        max_photo_submits: 4,
        start_time: NOW_SEC - 20 * HOUR,
        close_time: NOW_SEC + 4 * HOUR,
        ...over,
    });
    const globalSetting = (map: Record<string, unknown>) =>
        settings.getEffectiveSetting.mockImplementation((k) =>
            Object.prototype.hasOwnProperty.call(map, k) ? map[k] : DEFAULT_SETTINGS[k],
        );

    test('a photo-count rule overrides the global window for its class', async () => {
        // Global says "only in the last hour" \u2014 this candidate has 4h left.
        globalSetting({ autoJoinWithinHoursOfEnd: 1 });
        // The rule widens it to 6h, so this one joins.
        rulesGive((target) => (target?.max_photo_submits === 4 ? { autoJoinWithinHoursOfEnd: 6 } : {}));
        const deps = makeDeps({ getMemberChallenges: openList([candidate()]) });
        const res = await runJoinPass('tok', NOW_MS, deps);
        expect(res.joined).toBe(1);
        expect(deps.submitToChallenge).toHaveBeenCalled();
    });

    test('a class rule can also make the timing STRICTER than the global', async () => {
        globalSetting({ autoJoinWithinHoursOfEnd: 48 });
        rulesGive((target) => (target?.max_photo_submits === 4 ? { autoJoinWithinHoursOfEnd: 1 } : {}));
        const deps = makeDeps({ getMemberChallenges: openList([candidate()]) });
        const res = await runJoinPass('tok', NOW_MS, deps);
        expect(res.joined).toBe(0);
        expect(res.results[0].status).toBe('skipped:too-early');
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
    });

    test('a percent rule REPLACES an inherited hours window, it does not intersect it', async () => {
        // The global hours window alone would defer (1h allowed, 4h left).
        globalSetting({ autoJoinWithinHoursOfEnd: 1 });
        // 83% elapsed clears a 75% anchor, so the candidate joins.
        rulesGive((target) => (target?.max_photo_submits === 4 ? { autoJoinAfterPercentElapsed: 75 } : {}));
        const deps = makeDeps({ getMemberChallenges: openList([candidate()]) });
        const res = await runJoinPass('tok', NOW_MS, deps);
        expect(res.joined).toBe(1);
    });

    test('a percent rule defers a candidate that has not run long enough yet', async () => {
        globalSetting({ autoJoinWithinHoursOfEnd: 0 });
        rulesGive((target) => (target?.max_photo_submits === 4 ? { autoJoinAfterPercentElapsed: 90 } : {}));
        const deps = makeDeps({ getMemberChallenges: openList([candidate()]) });
        const res = await runJoinPass('tok', NOW_MS, deps);
        expect(res.joined).toBe(0);
        expect(res.results[0].status).toBe('skipped:too-early');
    });

    test('the same percent anchor defers a long challenge and joins a short one', async () => {
        globalSetting({ autoJoinWithinHoursOfEnd: 0, autoJoinAfterPercentElapsed: 75 });
        const deps = makeDeps({
            getMemberChallenges: openList([
                // 24h challenge, 20h in (83%) \u2014 joins.
                candidate({ id: 1 }),
                // 515.7h exhibition, 20h in (4%) \u2014 deferred, though it has the
                // same 4h-vs-hours shape a fixed window could not tell apart.
                candidate({
                    id: 2,
                    type: 'exhibition',
                    title: 'My Best Shot',
                    close_time: NOW_SEC + 495.7 * HOUR,
                }),
            ]),
        });
        const res = await runJoinPass('tok', NOW_MS, deps);
        expect(res.joined).toBe(1);
        expect(res.results.map((r) => r.status)).toEqual(['joined', 'skipped:too-early']);
    });

    test('a candidate with no start_time is deferred, never joined early', async () => {
        globalSetting({ autoJoinWithinHoursOfEnd: 0, autoJoinAfterPercentElapsed: 75 });
        const deps = makeDeps({
            getMemberChallenges: openList([candidate({ start_time: undefined })]),
        });
        const res = await runJoinPass('tok', NOW_MS, deps);
        expect(res.joined).toBe(0);
        expect(res.results[0].status).toBe('skipped:start-time-unknown');
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
    });
});

describe('joinChallenges — edge paths', () => {
    const logger: LoggerMock = invalid(require('../../src/ts/logger'));
    const autoFill = jest.mocked(require('../../src/ts/services/autoFill') as typeof autoFillModule);
    const warnings = () => logger.withCategory().warning.mock.calls.map(([msg]) => msg);
    const errors = () => logger.withCategory().error.mock.calls.map(([msg]) => msg);

    describe('title matching', () => {
        test('a titleless candidate still consults the rules (they may key on tags, type, photos, runtime)', () => {
            rulesGive(() => ({ autoJoinMaxCoins: 7 }));
            expect(resolveJoinSetting('autoJoinMaxCoins', invalid({ tags: ['Exhibition'] }))).toBe(7);
            expect(settings.resolveRuleSetting).toHaveBeenCalledWith('autoJoinMaxCoins', { tags: ['Exhibition'] });
        });

        test('a rule opt-in on a titleless candidate bypasses an excluded type', async () => {
            settings.getEffectiveSetting.mockImplementation((k) =>
                k === 'autoJoinExcludeTypes' ? 'flash' : DEFAULT_SETTINGS[k],
            );
            settings.hasRuleJoinOptIn.mockImplementation(
                (target) => Array.isArray(target?.tags) && target.tags.includes('Exhibition'),
            );
            const deps = makeDeps({
                getMemberChallenges: openList([
                    { id: 1, join_coins: 0, type: 'flash', tags: ['Exhibition'] },
                    { id: 2, join_coins: 0, type: 'flash', tags: [] },
                ]),
            });
            const res = await runJoinPass('tok', Date.now(), deps);
            expect(res.results).toEqual([
                { id: 1, status: 'joined' },
                { id: 2, status: 'skipped:excluded-type' },
            ]);
        });
    });

    describe('arming (anyTitleRuleEnablesAutoJoin)', () => {
        beforeEach(() => {
            settings.getEffectiveSetting.mockImplementation((k) => (k === 'autoJoin' ? false : DEFAULT_SETTINGS[k]));
        });

        test('a non-array rules value never arms', () => {
            settings.getTitleRules.mockReturnValue(invalid({ not: 'a list' }));
            expect(isAutoJoinActive()).toBe(false);
        });

        test('a rule without a profile name is skipped; a later profiled rule arms', () => {
            settings.getTitleRules.mockReturnValue([
                { title: 'A', profile: '' },
                { title: 'B', profile: 'p' },
            ]);
            settings.getChallengeProfiles.mockReturnValue({ p: { autoJoin: true } });
            expect(isAutoJoinActive()).toBe(true);
        });
    });

    describe('join-window diagnostics', () => {
        test('a null candidate is deferred and the diagnostic reports no fields', async () => {
            settings.getEffectiveSetting.mockImplementation((k) =>
                k === 'autoJoinWithinHoursOfEnd' ? 24 : DEFAULT_SETTINGS[k],
            );
            const deps = makeDeps({ getMemberChallenges: openList([null]) });
            const res = await runJoinPass('tok', 1_700_000_000_000, deps);
            expect(res.results).toEqual([{ id: undefined, status: 'skipped:close-time-unknown' }]);
            expect(warnings().some((m) => m.includes('no readable close_time') && m.endsWith('(none)'))).toBe(true);
        });
    });

    describe('join-state store failures', () => {
        test('a store whose read throws is unreadable → no spend (Error and non-Error)', async () => {
            for (const thrown of [new Error('EIO'), 'raw-failure']) {
                jest.clearAllMocks();
                const deps = makeDeps({
                    joinStateStore: {
                        readRaw: () => {
                            throw thrown;
                        },
                        writeRaw: jest.fn(),
                    },
                });
                const res = await performJoin(invalid({ id: 3 }), 'tok', deps, 100);
                expect(res).toEqual({ status: 'failed-no-charge', charged: 0 });
                expect(deps.coinsUnlock).not.toHaveBeenCalled();
                const text = thrown instanceof Error ? thrown.message : thrown;
                expect(warnings()).toContain(`could not read join-state: ${text}`);
            }
        });

        test.each([[''], ['  \n']])(
            'a join-state file that is empty (%j) is unreadable, not "no claims": a write cut short may have held one',
            async (empty) => {
                const store = { readRaw: () => empty, writeRaw: jest.fn() };
                const deps = makeDeps({ joinStateStore: store });
                expect(await performJoin(invalid({ id: 3 }), 'tok', deps, 100)).toEqual({
                    status: 'failed-no-charge',
                    charged: 0,
                });
                expect(deps.coinsUnlock).not.toHaveBeenCalled();
                expect(store.writeRaw).not.toHaveBeenCalled();
                expect(warnings()).toContain('join-state file is empty — treating as unreadable');
            },
        );

        test('a join-state file that is valid JSON but not an object is unreadable → no spend', async () => {
            const deps = makeDeps({ joinStateStore: { readRaw: () => '[1,2]', writeRaw: jest.fn() } });
            expect(await performJoin(invalid({ id: 3 }), 'tok', deps, 100)).toEqual({
                status: 'failed-no-charge',
                charged: 0,
            });
            expect(warnings()).toContain('join-state file is malformed (not an object) — treating as unreadable');
            expect(errors()).toContain('challenge 3: join-state is unreadable — not spending coins');
        });

        // A store that reads as the given files in turn, then as a corrupt one: a writer that read it as empty would wipe
        // every other claim on its next write.
        const readsThenCorrupt = (files: string[]) => {
            const queue = [...files];
            const writeRaw = jest.fn<void, [string]>();
            return { readRaw: () => (queue.length > 0 ? queue.shift()! : 'not json{{'), writeRaw };
        };

        test('a claim cannot be recorded when the file became unreadable since it was checked: no spend, nothing written', async () => {
            // The join's own read, the unlock section's read, then the writer's.
            const store = readsThenCorrupt(['{}', '{}']);
            const deps = makeDeps({ joinStateStore: store });
            expect(await performJoin(invalid({ id: 3 }), 'tok', deps, 100)).toEqual({
                status: 'failed-no-charge',
                charged: 0,
            });
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
            expect(store.writeRaw).not.toHaveBeenCalled();
        });

        test('an unlock that got no answer cannot be flagged in an unreadable file: nothing written, worded as charged', async () => {
            const store = readsThenCorrupt(['{}', '{}', '{}']);
            const deps = makeDeps({
                joinStateStore: store,
                coinsUnlock: double<'coinsUnlock'>(async () => ({ ok: false, raw: null, unclear: true })),
            });
            const outcome = await performJoin(invalid({ id: 3 }), 'tok', deps, 100);
            expect(outcome).toMatchObject({ status: 'charged-pending-submit', maybeCharged: 100 });
            expect(outcome.reason).toBeUndefined();
            // Only the claim itself was written; the flag was not, so the other claims were not wiped.
            expect(store.writeRaw).toHaveBeenCalledTimes(1);
        });

        test('a claim is not cleared from an unreadable file after a successful join: nothing written, the join still succeeds', async () => {
            // The join's own read and the one under the lock before the submit, then a corrupt file.
            const claims = JSON.stringify({ 4: { unlockedAt: RECENT }, 5: { unlockedAt: RECENT } });
            const store = readsThenCorrupt([claims, claims]);
            const deps = makeDeps({ joinStateStore: store });
            expect(await performJoin(invalid({ id: 4 }), 'tok', deps, 100)).toMatchObject({ status: 'joined' });
            expect(store.writeRaw).not.toHaveBeenCalled();
            expect(warnings()).toContain(
                'could not clear unlock marker for 4: join-state is unreadable — nothing written',
            );
        });

        test('a claim of an account is logged by its challenge id only, never by the member id in its key', async () => {
            const member = 'c'.repeat(32);
            (
                require('../../src/ts/services/autoFill/memberIdentity') as typeof memberIdentityModule
            ).__resetMemberIdCache();
            const store = {
                readRaw: () => JSON.stringify({ [`${member}:4`]: { unlockedAt: RECENT } }),
                writeRaw: jest.fn(() => {
                    throw new Error('read-only');
                }),
            };
            const deps = makeDeps({
                joinStateStore: store,
                getCurrentMemberProfile: jest.fn(async () => ({ id: member, userName: 'u' })),
            });
            await performJoin(invalid({ id: 4 }), 'tok', deps, 100);
            expect(warnings()).toContain('could not clear unlock marker for 4: read-only');
            expect(warnings().some((line) => String(line).includes(member))).toBe(false);
        });

        test('a failure to clear the marker after a successful join is logged, the join still succeeds', async () => {
            let raw: string | null = JSON.stringify({ 4: { unlockedAt: RECENT } });
            const deps = makeDeps({
                joinStateStore: {
                    readRaw: () => raw,
                    writeRaw: jest.fn(() => {
                        throw new Error('read-only');
                    }),
                },
            });
            const res = await performJoin(invalid({ id: 4 }), 'tok', deps, 100);
            expect(res).toMatchObject({ status: 'joined', charged: 0 });
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
            expect(warnings()).toContain('could not clear unlock marker for 4: read-only');
            raw = null;
        });

        test('a non-Error thrown while persisting the claim refuses the spend and is reported as-is', async () => {
            const deps = makeDeps({
                joinStateStore: {
                    readRaw: () => null,
                    writeRaw: () => {
                        throw 'disk full';
                    },
                },
            });
            expect(await performJoin(invalid({ id: 4 }), 'tok', deps, 100)).toEqual({
                status: 'failed-no-charge',
                charged: 0,
            });
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
            expect(warnings()).toContain('could not persist unlock marker for 4: disk full');
        });

        test('a non-Error thrown while clearing the marker is reported as-is', async () => {
            const deps = makeDeps({
                joinStateStore: {
                    readRaw: () => JSON.stringify({ 4: { unlockedAt: RECENT } }),
                    writeRaw: () => {
                        throw 'nope';
                    },
                },
            });
            await performJoin(invalid({ id: 4 }), 'tok', deps, 100);
            expect(warnings()).toContain('could not clear unlock marker for 4: nope');
        });

        test('clearing when this challenge has no marker writes nothing', async () => {
            const writeRaw = jest.fn();
            const deps = makeDeps({ joinStateStore: { readRaw: () => JSON.stringify({ other: {} }), writeRaw } });
            expect((await performJoin(invalid({ id: 5 }), 'tok', deps, 0)).status).toBe('joined');
            expect(writeRaw).not.toHaveBeenCalled();
        });
    });

    describe('mock mode (no join-state store)', () => {
        test('a paid join with joinStateStore null unlocks and submits without persisting', async () => {
            const deps = makeDeps({ joinStateStore: null });
            expect(await performJoin(invalid({ id: 6 }), 'tok', deps, 50)).toEqual({
                status: 'joined',
                charged: 50,
                imageId: 'imgA',
            });
            expect(deps.coinsUnlock).toHaveBeenCalledWith(6, 'tok');
        });
    });

    describe('performJoin — remaining outcomes', () => {
        test('another process unlocked between the first check and the lock → submit only, no re-charge', async () => {
            const reads = [
                null,
                JSON.stringify({ 8: { unlockedAt: RECENT } }),
                JSON.stringify({ 8: { unlockedAt: RECENT } }),
            ];
            const deps = makeDeps({ joinStateStore: { readRaw: () => reads.shift() ?? null, writeRaw: jest.fn() } });
            const res = await performJoin(invalid({ id: 8 }), 'tok', deps, 100);
            expect(res).toMatchObject({ status: 'joined', charged: 0 });
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
            expect(deps.submitToChallenge).toHaveBeenCalledWith(8, ['imgA'], 'tok');
        });

        test('a free join with a leftover marker cancelled before submit is not reported as charged', async () => {
            cancellation.isCancelled.mockReturnValue(true);
            const marked = JSON.stringify({ '2': { unlockedAt: RECENT } });
            const deps = makeDeps({ joinStateStore: { readRaw: () => marked, writeRaw: jest.fn() } });
            expect(await performJoin(invalid({ id: 2 }), 'tok', deps, 0)).toEqual({
                status: 'failed-no-charge',
                charged: 0,
            });
        });

        test('free join cancelled before submit → failed-no-charge', async () => {
            cancellation.isCancelled.mockReturnValue(true);
            const deps = makeDeps();
            expect(await performJoin(invalid({ id: 9 }), 'tok', deps, 0)).toEqual({
                status: 'failed-no-charge',
                charged: 0,
            });
            expect(deps.submitToChallenge).not.toHaveBeenCalled();
        });

        test('free join whose submit fails → failed-no-charge', async () => {
            const deps = makeDeps({ submitToChallenge: double<'submitToChallenge'>(async () => ({ ok: false })) });
            expect(await performJoin(invalid({ id: 9 }), 'tok', deps, 0)).toEqual({
                status: 'failed-no-charge',
                charged: 0,
            });
        });

        test('a retried submit of an already-paid join that fails again stays pending, not re-charged', async () => {
            const deps = makeDeps({
                joinStateStore: { readRaw: () => JSON.stringify({ 10: { unlockedAt: RECENT } }), writeRaw: jest.fn() },
                submitToChallenge: double<'submitToChallenge'>(async () => null),
            });
            expect(await performJoin(invalid({ id: 10 }), 'tok', deps, 100)).toEqual({
                status: 'charged-pending-submit',
                charged: 0,
            });
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
        });

        test('the photo library throwing skips the candidate (Error and non-Error)', async () => {
            for (const thrown of [new Error('library down'), 'raw']) {
                jest.clearAllMocks();
                autoFill.fetchCandidatesForChallenge.mockRejectedValueOnce(thrown);
                const deps = makeDeps();
                expect(await performJoin(invalid({ id: 11 }), 'tok', deps, 100)).toEqual({
                    status: 'skipped-no-photo',
                    charged: 0,
                });
                const text = thrown instanceof Error ? thrown.message : thrown;
                expect(warnings()).toContain(`could not read eligible photos for 11: ${text}`);
            }
        });

        test('a picker returning nothing at all is "no photo"', async () => {
            photoPicker.pickPhotosForChallenge.mockReturnValue(invalid(null));
            expect((await performJoin(invalid({ id: 12 }), 'tok', makeDeps(), 0)).status).toBe('skipped-no-photo');
        });
    });

    describe('runJoinPass — remaining outcomes', () => {
        test('no token → not run', async () => {
            const deps = makeDeps();
            expect(await runJoinPass('', Date.now(), deps)).toEqual({ ran: false, joined: 0, results: [] });
            expect(deps.getMemberChallenges).not.toHaveBeenCalled();
        });

        test('listing open challenges throws → not run (Error and non-Error)', async () => {
            for (const thrown of [new Error('503'), 'raw']) {
                jest.clearAllMocks();
                const deps = makeDeps({ getMemberChallenges: jest.fn().mockRejectedValue(thrown) });
                expect(await runJoinPass('tok', Date.now(), deps)).toEqual({ ran: false, joined: 0, results: [] });
                const text = thrown instanceof Error ? thrown.message : thrown;
                expect(warnings()).toContain(`could not list open challenges: ${text}`);
            }
        });

        test('a failed listing (null) is not "no open challenges": not run, and said so', async () => {
            const deps = makeDeps({ getMemberChallenges: double<'getMemberChallenges'>(async () => null) });
            expect(await runJoinPass('tok', Date.now(), deps)).toEqual({ ran: false, joined: 0, results: [] });
            expect(warnings()).toContain('could not list open challenges: the request failed');
            expect(deps.getBankroll).not.toHaveBeenCalled();
        });

        test('the pass only ever asks for open challenges, upcoming ones are never joined', async () => {
            const deps = makeDeps({
                getMemberChallenges: double<'getMemberChallenges'>(async (_token, filter) =>
                    filter === 'open' ? [] : [{ id: 9, join_coins: 0, type: 'flash', status: 'upcoming' }],
                ),
            });
            expect(await runJoinPass('tok', Date.now(), deps)).toEqual({ ran: true, joined: 0, results: [] });
            expect(deps.getMemberChallenges).toHaveBeenCalledTimes(1);
            expect(deps.getMemberChallenges).toHaveBeenCalledWith('tok', 'open');
            expect(deps.submitToChallenge).not.toHaveBeenCalled();
        });

        test('no open challenges → ran, nothing joined, no balance read', async () => {
            const deps = makeDeps({ getMemberChallenges: openList([]) });
            expect(await runJoinPass('tok', Date.now(), deps)).toEqual({ ran: true, joined: 0, results: [] });
            expect(deps.getBankroll).not.toHaveBeenCalled();
        });

        test('a non-Error thrown by the balance read is reported and paid joins are skipped', async () => {
            const deps = makeDeps({
                getMemberChallenges: openList([{ id: 1, join_coins: 100, type: 'flash' }]),
                getBankroll: jest.fn().mockRejectedValue('bank down'),
            });
            const res = await runJoinPass('tok', Date.now(), deps);
            expect(res.joined).toBe(0);
            expect(warnings()).toContain('could not read balance (paid joins skipped this pass): bank down');
        });

        test('a missing/invalid clock falls back to the wall clock for the join window', async () => {
            settings.getEffectiveSetting.mockImplementation((k) =>
                k === 'autoJoinWithinHoursOfEnd' ? 1 : DEFAULT_SETTINGS[k],
            );
            const closeSoon = Math.floor(Date.now() / 1000) + 600;
            const deps = makeDeps({
                getMemberChallenges: openList([{ id: 1, join_coins: 0, type: 'flash', close_time: closeSoon }]),
            });
            expect((await runJoinPass('tok', invalid(undefined), deps)).joined).toBe(1);
        });

        test('cancellation stops the pass before the next candidate', async () => {
            cancellation.isCancelled.mockReturnValue(true);
            const deps = makeDeps({ getMemberChallenges: openList([{ id: 1, join_coins: 0 }]) });
            expect(await runJoinPass('tok', Date.now(), deps)).toEqual({ ran: true, joined: 0, results: [] });
            expect(warnings()).toContain('join pass cancelled by user');
        });

        test('a numeric-string balance allows the paid join and is decremented for later candidates', async () => {
            // Budget (300) covers both joins, so only the balance can stop the second.
            const bankroll = { coins: '150' };
            const deps = makeDeps({
                getMemberChallenges: openList([
                    { id: 1, join_coins: 100, type: 'flash' },
                    { id: 2, join_coins: 100, type: 'flash' },
                ]),
                getBankroll: double<'getBankroll'>(async () => bankroll),
            });
            const res = await runJoinPass('tok', Date.now(), deps);
            expect(res.results[0]).toEqual({ id: 1, status: 'joined' });
            expect(res.results[1]).toEqual({ id: 2, status: 'skipped:insufficient-coins' });
            expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);
            expect(bankroll.coins).toBe(50);
        });

        test('a candidate with no eligible photo is reported and not counted as joined', async () => {
            photoPicker.pickPhotosForChallenge.mockReturnValue([]);
            const deps = makeDeps({ getMemberChallenges: openList([{ id: 1, join_coins: 0 }]) });
            expect(await runJoinPass('tok', Date.now(), deps)).toEqual({
                ran: true,
                joined: 0,
                results: [{ id: 1, status: 'skipped-no-photo' }],
            });
        });

        test('a thrown non-Error from a candidate join is logged by value', async () => {
            photoPicker.pickPhotosForChallenge.mockImplementationOnce(() => {
                throw 'picker boom';
            });
            const deps = makeDeps({ getMemberChallenges: openList([{ id: 1, join_coins: 0 }]) });
            const res = await runJoinPass('tok', Date.now(), deps);
            expect(res.results).toEqual([{ id: 1, status: 'error' }]);
            expect(warnings()).toContain('join failed for challenge 1: picker boom');
        });
    });

    describe('joinChallengeSingle — remaining outcomes', () => {
        const paid = () => openList([{ id: 2, join_coins: 100, type: 'flash' }]);

        test('no token → not-authenticated without any API call', async () => {
            const deps = makeDeps();
            expect(await joinChallengeSingle(2, invalid(null), deps)).toEqual({
                status: 'not-authenticated',
                challengeId: 2,
                cost: 0,
            });
            expect(deps.getMemberChallenges).not.toHaveBeenCalled();
        });

        test('omitting opts means "do not spend" → needs-confirm', async () => {
            const deps = makeDeps({ getMemberChallenges: paid() });
            expect(await joinChallengeSingle(2, 'tok', deps)).toEqual({
                status: 'needs-confirm',
                challengeId: 2,
                cost: 100,
            });
        });

        test('listing throws → fetch-failed (Error and non-Error)', async () => {
            for (const thrown of [new Error('503'), 'raw']) {
                const deps = makeDeps({ getMemberChallenges: jest.fn().mockRejectedValue(thrown) });
                expect(await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).toEqual({
                    status: 'fetch-failed',
                    challengeId: 2,
                    cost: 0,
                });
            }
        });

        test('a failed listing (null) → fetch-failed, and the upcoming list is not asked about', async () => {
            const deps = makeDeps({ getMemberChallenges: double<'getMemberChallenges'>(async () => null) });
            expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).status).toBe('fetch-failed');
            expect(deps.getMemberChallenges).toHaveBeenCalledTimes(1);
        });

        describe('an id the live open list does not hold', () => {
            // Open and upcoming answer apart, as the server does.
            const lists = (upcoming: unknown) =>
                double<'getMemberChallenges'>(async (_token, filter) => (filter === 'upcoming' ? upcoming : []));
            const spent = (deps: ReturnType<typeof makeDeps>) =>
                [deps.coinsUnlock, deps.submitToChallenge].some((fn) => jest.mocked(fn).mock.calls.length > 0);

            test.each([[true], [false]])(
                'named by a live upcoming call → not-started, nothing spent (spendCoins %p)',
                async (spendCoins) => {
                    const deps = makeDeps({ getMemberChallenges: lists([{ id: 7, join_coins: 100 }]) });
                    expect(await joinChallengeSingle(7, 'tok', deps, { spendCoins })).toEqual({
                        status: 'not-started',
                        challengeId: 7,
                        cost: 0,
                    });
                    expect(deps.getMemberChallenges).toHaveBeenNthCalledWith(1, 'tok', 'open');
                    expect(deps.getMemberChallenges).toHaveBeenNthCalledWith(2, 'tok', 'upcoming');
                    expect(deps.getBankroll).not.toHaveBeenCalled();
                    expect(spent(deps)).toBe(false);
                },
            );

            test('a challenge that has since started or been joined is in neither list → unavailable', async () => {
                const deps = makeDeps({ getMemberChallenges: lists([{ id: 8 }]) });
                expect((await joinChallengeSingle(7, 'tok', deps, { spendCoins: true })).status).toBe('unavailable');
            });

            test('the id is compared as text', async () => {
                const deps = makeDeps({ getMemberChallenges: lists([{ id: '7' }]) });
                expect((await joinChallengeSingle(7, 'tok', deps)).status).toBe('not-started');
            });

            test('a failed or throwing upcoming call → unavailable, nothing spent', async () => {
                // null: the request failed; the rest: the call threw (an Error, a bare string, nothing at all).
                for (const upcoming of [null, new Error('503'), 'raw', undefined]) {
                    const getMemberChallenges = jest.fn(async (_token, filter) => {
                        if (filter === 'open') return [];
                        if (upcoming !== null) throw upcoming;
                        return upcoming;
                    });
                    const deps = makeDeps({ getMemberChallenges });
                    expect((await joinChallengeSingle(7, 'tok', deps, { spendCoins: true })).status).toBe(
                        'unavailable',
                    );
                    expect(spent(deps)).toBe(false);
                }
                expect(warnings()).toEqual(
                    expect.arrayContaining([
                        'could not list upcoming challenges: 503',
                        'could not list upcoming challenges: raw',
                        'could not list upcoming challenges: undefined',
                    ]),
                );
            });

            test('an open challenge never asks for the upcoming list', async () => {
                const deps = makeDeps({ getMemberChallenges: paid() });
                expect((await joinChallengeSingle(2, 'tok', deps)).status).toBe('needs-confirm');
                expect(deps.getMemberChallenges).toHaveBeenCalledTimes(1);
            });
        });

        test.each([[null], [{}], [{ coins: 'lots' }]])('bankroll %p → balance-unknown, no spend', async (bankroll) => {
            const deps = makeDeps({
                getMemberChallenges: paid(),
                getBankroll: double<'getBankroll'>(async () => bankroll),
            });
            expect(await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).toEqual({
                status: 'balance-unknown',
                challengeId: 2,
                cost: 100,
            });
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
        });

        test('not enough coins → skipped-unaffordable with the balance', async () => {
            const deps = makeDeps({ getMemberChallenges: paid(), getBankroll: balance({ coins: 40 }) });
            expect(await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).toEqual({
                status: 'skipped-unaffordable',
                challengeId: 2,
                cost: 100,
                coins: 40,
            });
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
        });

        test('a free challenge joins without reading the balance', async () => {
            const deps = makeDeps({ getMemberChallenges: openList([{ id: 3, join_coins: 'free' }]) });
            expect(await joinChallengeSingle(3, 'tok', deps, { spendCoins: false })).toEqual({
                status: 'joined',
                challengeId: 3,
                cost: 0,
                imageId: 'imgA',
            });
            expect(deps.getBankroll).not.toHaveBeenCalled();
        });
    });
});
