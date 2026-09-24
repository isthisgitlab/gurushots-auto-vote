/**
 * Tests for services/joinChallenges.js — the paid-spend safety model:
 * photo-first ordering, unlock/submit idempotency, the double-spend lock,
 * budget accounting, cancellation, and the null-bankroll fail-safe.
 */

jest.mock('../../src/js/logger', () => {
    const level = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return { withCategory: jest.fn(() => level), challengeTag: (c) => `challenge ${c?.id}` };
});
jest.mock('../../src/js/voting/cancellation', () => ({ isCancelled: jest.fn(() => false) }));
jest.mock('../../src/js/services/autoFill', () => ({
    fetchCandidatesForChallenge: jest.fn(async () => [{ id: 'imgA', permission: { allowed: true } }]),
    resolveSemanticScores: jest.fn(async () => null),
}));
jest.mock('../../src/js/services/photoPicker', () => ({
    pickPhotosForChallenge: jest.fn(() => ['imgA']),
}));
jest.mock('../../src/js/services/visionVerifier', () => ({
    rankVisually: jest.fn(async (challenge, ids, eligible, wantCount) => ids.slice(0, wantCount)),
}));
jest.mock('../../src/js/settings', () => ({
    getEffectiveSetting: jest.fn((key) => {
        const map = {
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

const cancellation = require('../../src/js/voting/cancellation');
const photoPicker = require('../../src/js/services/photoPicker');
const settings = require('../../src/js/settings');
const {
    performJoin,
    runJoinPass,
    joinChallengeSingle,
    resolveJoinSetting,
    isAutoJoinActive,
    inFlight,
} = require('../../src/js/services/joinChallenges');

// The facade's rule readers take a CHALLENGE (so a rule keyed on tags, type,
// photo count or runtime can match on the candidate itself).
const titleOf = (target) => target?.title;

// The facade resolves a key through the matching rules (list order, inline
// before profile). Tests describe what the rules contribute for a candidate as
// a plain map; this stands in for that cascade.
const rulesGive = (valuesFor) =>
    settings.resolveRuleSetting.mockImplementation((key, target) => {
        const values = valuesFor(target) || {};
        return Object.prototype.hasOwnProperty.call(values, key) ? { value: values[key] } : null;
    });

const makeStore = () => {
    let s = null;
    return { readRaw: () => s, writeRaw: (d) => (s = d) };
};
const makeDeps = (over = {}) => ({
    getMemberChallenges: jest.fn(async () => []),
    getBankroll: jest.fn(async () => ({ coins: 1000 })),
    coinsUnlock: jest.fn(async () => ({ ok: true })),
    submitToChallenge: jest.fn(async () => ({ ok: true })),
    getEligiblePhotos: jest.fn(),
    getImageData: jest.fn(),
    joinStateStore: makeStore(),
    ...over,
});

const DEFAULT_SETTINGS = {
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
        const res = await performJoin({ id: 1 }, 'tok', deps, 0);
        expect(res.status).toBe('joined');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
        expect(deps.submitToChallenge).toHaveBeenCalledWith(1, ['imgA'], 'tok');
    });

    test('joins with the visually re-ranked photo from a 12-photo shortlist', async () => {
        photoPicker.pickPhotosForChallenge.mockReturnValue(['imgA', 'imgB']);
        const rankVisually = jest.fn(async () => ['imgB']);
        const challenge = { id: 3, title: 'Glorious Green Leaves' };
        const deps = makeDeps({ rankVisually });
        const res = await performJoin(challenge, 'tok', deps, 0);
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
        const res = await performJoin({ id: 1 }, 'tok', deps, 100);
        expect(res.status).toBe('skipped-no-photo');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
    });

    test('paid join: unlock then submit, marker cleared on success', async () => {
        const deps = makeDeps();
        const res = await performJoin({ id: 7 }, 'tok', deps, 100);
        expect(res).toMatchObject({ status: 'joined', charged: 100 });
        expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);
        // marker cleared on success → no '7' key
        const state = JSON.parse(deps.joinStateStore.readRaw() || '{}');
        expect(state['7']).toBeUndefined();
    });

    test('unlock ok but submit fails → charged-pending-submit + marker persisted; retry does NOT re-unlock', async () => {
        const deps = makeDeps({
            submitToChallenge: jest.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true }),
        });
        const first = await performJoin({ id: 9 }, 'tok', deps, 100);
        expect(first).toMatchObject({ status: 'charged-pending-submit', charged: 100 });
        expect(JSON.parse(deps.joinStateStore.readRaw())['9']).toBeDefined();
        expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);

        // Retry: marker present → skip unlock, submit only.
        const second = await performJoin({ id: 9 }, 'tok', deps, 100);
        expect(second.status).toBe('joined');
        expect(deps.coinsUnlock).toHaveBeenCalledTimes(1); // NOT called again
        expect(JSON.parse(deps.joinStateStore.readRaw() || '{}')['9']).toBeUndefined();
    });

    test('unlock failure → failed-no-charge, no submit', async () => {
        const deps = makeDeps({ coinsUnlock: jest.fn(async () => ({ ok: false })) });
        const res = await performJoin({ id: 3 }, 'tok', deps, 100);
        expect(res.status).toBe('failed-no-charge');
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
    });

    test('claim cannot be persisted → NO coins spent (no coinsUnlock call)', async () => {
        const brokenStore = {
            readRaw: () => null,
            writeRaw: () => {
                throw new Error('disk full');
            },
        };
        const deps = makeDeps({ joinStateStore: brokenStore });
        const res = await performJoin({ id: 11 }, 'tok', deps, 100);
        expect(res.status).toBe('failed-no-charge');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
    });

    test('claim is persisted BEFORE the charge (unlock sees the marker on disk)', async () => {
        const store = makeStore();
        const deps = makeDeps({
            joinStateStore: store,
            coinsUnlock: jest.fn(async (id) => {
                // The claim must already be on disk at the moment we spend.
                expect(JSON.parse(store.readRaw())[String(id)]).toBeDefined();
                return { ok: true };
            }),
        });
        const res = await performJoin({ id: 12 }, 'tok', deps, 100);
        expect(res.status).toBe('joined');
    });

    test('in-flight lock rejects a concurrent join for the same challenge', async () => {
        inFlight.add('5');
        const deps = makeDeps();
        const res = await performJoin({ id: 5 }, 'tok', deps, 100);
        expect(res.status).toBe('busy');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('cancellation before unlock → failed-no-charge, no spend', async () => {
        cancellation.isCancelled.mockReturnValue(true);
        const deps = makeDeps();
        const res = await performJoin({ id: 8 }, 'tok', deps, 100);
        expect(res.status).toBe('failed-no-charge');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('cancelling a retry of an already-charged join reports pending-submit, not "no charge"', async () => {
        const store = makeStore();
        store.writeRaw(JSON.stringify({ 14: { unlockedAt: 1 } })); // prior cycle already unlocked
        cancellation.isCancelled.mockReturnValue(true);
        const deps = makeDeps({ joinStateStore: store });
        const res = await performJoin({ id: 14 }, 'tok', deps, 100);
        expect(res.status).toBe('charged-pending-submit');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('corrupt join-state → refuse to spend (fail-safe)', async () => {
        const corruptStore = { readRaw: () => 'not json{{', writeRaw: jest.fn() };
        const deps = makeDeps({ joinStateStore: corruptStore });
        const res = await performJoin({ id: 15 }, 'tok', deps, 100);
        expect(res.status).toBe('failed-no-charge');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('cross-process lock held → busy, no spend', async () => {
        const deps = makeDeps({ acquireUnlockLock: jest.fn(() => ({ ok: false, release: () => {} })) });
        const res = await performJoin({ id: 16 }, 'tok', deps, 100);
        expect(res.status).toBe('busy');
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('cross-process lock is released after the unlock section', async () => {
        const release = jest.fn();
        const deps = makeDeps({ acquireUnlockLock: jest.fn(() => ({ ok: true, release })) });
        await performJoin({ id: 17 }, 'tok', deps, 100);
        expect(release).toHaveBeenCalledTimes(1);
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
        settings.getTitleRules.mockReturnValue([{ title: 'X', profile: 'p' }, null]);
        settings.getChallengeProfiles.mockReturnValue(null);
        expect(isAutoJoinActive()).toBe(false);
    });
});

describe('resolveJoinSetting', () => {
    test('returns the value the rules resolve, passing the whole candidate', () => {
        rulesGive(() => ({ autoJoinMaxCoins: 50 }));
        settings.getEffectiveSetting.mockReturnValue(999);
        const candidate = { title: 'X', tags: ['Exhibition'], max_photo_submits: 4 };
        expect(resolveJoinSetting('autoJoinMaxCoins', candidate)).toBe(50);
        expect(settings.resolveRuleSetting).toHaveBeenCalledWith('autoJoinMaxCoins', candidate);
    });

    test('no rule sets the key → global default', () => {
        settings.getEffectiveSetting.mockReturnValue(7);
        expect(resolveJoinSetting('autoJoinMaxCoins', { title: 'X' })).toBe(7);
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('autoJoinMaxCoins', null);
    });

    test('a rule false is honored, not treated as absent', () => {
        rulesGive(() => ({ autoJoin: false }));
        settings.getEffectiveSetting.mockReturnValue(true);
        expect(resolveJoinSetting('autoJoin', { title: 'X' })).toBe(false);
    });

    test('a rule 0 window is honored, not treated as absent', () => {
        rulesGive(() => ({ autoJoinWithinHoursOfEnd: 0 }));
        settings.getEffectiveSetting.mockReturnValue(24);
        expect(resolveJoinSetting('autoJoinWithinHoursOfEnd', { title: 'X' })).toBe(0);
    });

    test('degrades to the global default when the settings facade has no rule resolver', () => {
        // An older persisted facade has no resolveRuleSetting at all; the
        // optional call must not throw mid-pass.
        const saved = settings.resolveRuleSetting;
        delete settings.resolveRuleSetting;
        try {
            settings.getEffectiveSetting.mockReturnValue(7);
            expect(resolveJoinSetting('autoJoinMaxCoins', { title: 'X' })).toBe(7);
        } finally {
            settings.resolveRuleSetting = saved;
        }
    });
});

describe('runJoinPass', () => {
    test('does nothing when the master is off AND there are no title rules', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => (k === 'autoJoin' ? false : undefined));
        settings.getTitleRules.mockReturnValue([]);
        const deps = makeDeps({ getMemberChallenges: jest.fn(async () => [{ id: 1, join_coins: 0, type: 'flash' }]) });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.ran).toBe(false);
        expect(deps.getMemberChallenges).not.toHaveBeenCalled();
    });

    test('master off with only photo-tag rules (no join profile) → pass short-circuits, no API calls', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => (k === 'autoJoin' ? false : DEFAULT_SETTINGS[k]));
        // A rule that only adds photo tags carries no profile that enables
        // autoJoin, so nothing arms the pass → it must not run.
        settings.getTitleRules.mockReturnValue([{ title: 'Tagged', mustIncludeTags: ['x'] }]);
        const deps = makeDeps({ getMemberChallenges: jest.fn(async () => [{ id: 1, join_coins: 0, type: 'flash' }]) });
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
            getMemberChallenges: jest.fn(async () => [
                { id: 1, join_coins: 0, type: 'flash', title: 'Joinable' },
                { id: 2, join_coins: 0, type: 'flash', title: 'Other' },
            ]),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        const byId = Object.fromEntries(res.results.map((r) => [r.id, r.status]));
        expect(byId[1]).toBe('joined');
        expect(byId[2]).toBe('skipped:autojoin-off');
        expect(res.joined).toBe(1);
    });

    test('master ON but a rule disables autoJoin → that title is skipped, others join', async () => {
        // Safety-relevant mirror of the enable case: an explicit false from the
        // rules must win over the master-on default (hasOwnProperty, not truthy).
        rulesGive((target) => (titleOf(target) === 'Excluded' ? { autoJoin: false } : {}));
        const deps = makeDeps({
            getMemberChallenges: jest.fn(async () => [
                { id: 1, join_coins: 0, type: 'flash', title: 'Excluded' },
                { id: 2, join_coins: 0, type: 'flash', title: 'Other' },
            ]),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        const byId = Object.fromEntries(res.results.map((r) => [r.id, r.status]));
        expect(byId[1]).toBe('skipped:autojoin-off');
        expect(byId[2]).toBe('joined');
    });

    test('getTitleRules throwing with master off → pass short-circuits (fail-safe)', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => (k === 'autoJoin' ? false : DEFAULT_SETTINGS[k]));
        settings.getTitleRules.mockImplementation(() => {
            throw new Error('corrupt settings');
        });
        const deps = makeDeps({ getMemberChallenges: jest.fn(async () => [{ id: 1, join_coins: 0, type: 'flash' }]) });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.ran).toBe(false);
        expect(deps.getMemberChallenges).not.toHaveBeenCalled();
    });

    test('joins free + affordable paid, respects the per-cycle budget', async () => {
        // budget 300, two paid @200 → only the first affordable
        settings.getEffectiveSetting.mockImplementation((k) => {
            const map = {
                autoJoin: true,
                autoJoinTypes: '',
                autoJoinMaxCoins: 250,
                autoJoinCycleCoinBudget: 300,
                fillWithoutTagMatch: true,
            };
            return map[k];
        });
        const deps = makeDeps({
            getMemberChallenges: jest.fn(async () => [
                { id: 1, join_coins: 0, type: 'flash' },
                { id: 2, join_coins: 200, type: 'flash' },
                { id: 3, join_coins: 200, type: 'flash' },
            ]),
            getBankroll: jest.fn(async () => ({ coins: 1000 })),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.joined).toBe(2); // free + first paid
        expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);
        const statuses = res.results.map((r) => r.status);
        expect(statuses).toContain('skipped:over-cycle-budget');
    });

    test('autoJoinExcludeTypes (raw string with spaces/case) excludes via the full pass wiring', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => {
            const map = {
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
            getMemberChallenges: jest.fn(async () => [
                { id: 1, join_coins: 0, type: 'flash' },
                { id: 2, join_coins: 0, type: 'contest' },
            ]),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        const byId = Object.fromEntries(res.results.map((r) => [r.id, r.status]));
        expect(byId[1]).toBe('skipped:excluded-type');
        expect(byId[2]).toBe('joined');
        expect(res.joined).toBe(1);
    });

    test('autoJoinTypes (include list) narrows the join set via the full pass wiring', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => {
            const map = {
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
            getMemberChallenges: jest.fn(async () => [
                { id: 1, join_coins: 0, type: 'flash' },
                { id: 2, join_coins: 0, type: 'contest' },
            ]),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        const byId = Object.fromEntries(res.results.map((r) => [r.id, r.status]));
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
            getMemberChallenges: jest.fn(async () => [
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
            getMemberChallenges: jest.fn(async () => [
                { id: 1, join_coins: 0, type: 'flash' },
                { id: 2, join_coins: 100, type: 'flash' },
            ]),
            getBankroll: jest.fn(async () => {
                throw new Error('network');
            }),
        });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.joined).toBe(1);
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('null bankroll → paid skipped, free still joins', async () => {
        settings.getEffectiveSetting.mockImplementation((k) => {
            const map = {
                autoJoin: true,
                autoJoinTypes: '',
                autoJoinMaxCoins: 250,
                autoJoinCycleCoinBudget: 300,
                fillWithoutTagMatch: true,
            };
            return map[k];
        });
        const deps = makeDeps({
            getMemberChallenges: jest.fn(async () => [
                { id: 1, join_coins: 0, type: 'flash' },
                { id: 2, join_coins: 100, type: 'flash' },
            ]),
            getBankroll: jest.fn(async () => null),
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
    const withWindow = (hours) =>
        settings.getEffectiveSetting.mockImplementation((k) =>
            k === 'autoJoinWithinHoursOfEnd' ? hours : DEFAULT_SETTINGS[k],
        );

    test('defers a candidate that is outside the window, spending nothing', async () => {
        withWindow(24);
        const deps = makeDeps({
            getMemberChallenges: jest.fn(async () => [
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
            getMemberChallenges: jest.fn(async () => [
                { id: 1, join_coins: 0, type: 'flash', title: 'Near', close_time: NOW_SEC + 5 * HOUR },
            ]),
        });
        const res = await runJoinPass('tok', NOW_MS, deps);
        expect(res.joined).toBe(1);
        expect(deps.submitToChallenge).toHaveBeenCalledTimes(1);
    });

    test('deferral is per-cycle: the same candidate joins on a later pass', async () => {
        withWindow(24);
        const closeTime = NOW_SEC + 30 * HOUR;
        const candidate = { id: 1, join_coins: 0, type: 'flash', title: 'Later', close_time: closeTime };
        const deps = makeDeps({ getMemberChallenges: jest.fn(async () => [candidate]) });

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
            getMemberChallenges: jest.fn(async () => [
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
            getMemberChallenges: jest.fn(async () => [
                { id: 1, join_coins: 0, type: 'flash', title: 'Far', close_time: NOW_SEC + 90 * 86400 },
            ]),
        });
        expect((await runJoinPass('tok', NOW_MS, deps)).joined).toBe(1);
    });

    test('a candidate with no close_time joins normally when no window is set', async () => {
        withWindow(0);
        const deps = makeDeps({
            getMemberChallenges: jest.fn(async () => [{ id: 1, join_coins: 0, type: 'flash', title: 'NoTime' }]),
        });
        expect((await runJoinPass('tok', NOW_MS, deps)).joined).toBe(1);
    });

    test('fail-closed: a missing close_time is deferred, not joined, while a window is set', async () => {
        withWindow(24);
        const deps = makeDeps({
            getMemberChallenges: jest.fn(async () => [{ id: 1, join_coins: 0, type: 'flash', title: 'NoTime' }]),
        });
        const res = await runJoinPass('tok', NOW_MS, deps);
        expect(res.joined).toBe(0);
        expect(res.results[0].status).toBe('skipped:close-time-unknown');
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
    });

    test('the missing-close_time diagnostic logs the payload shape once per pass', async () => {
        withWindow(24);
        const logger = require('../../src/js/logger');
        const deps = makeDeps({
            getMemberChallenges: jest.fn(async () => [
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
            getMemberChallenges: jest.fn(async () => [
                { id: 1, join_coins: 0, type: 'flash', title: 'Dead', close_time: NOW_SEC - 60 },
            ]),
        });
        const res = await runJoinPass('tok', NOW_MS, deps);
        expect(res.results[0].status).toBe('skipped:already-closed');
    });

    test('the window also defers a paid candidate before any unlock', async () => {
        withWindow(24);
        const deps = makeDeps({
            getMemberChallenges: jest.fn(async () => [
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
            getMemberChallenges: jest.fn(async () => [
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
            getMemberChallenges: jest.fn(async () => [
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
            getMemberChallenges: jest.fn(async () => [{ id: 1, join_coins: 0, type: 'flash', title: 'X' }]),
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
            getMemberChallenges: jest.fn(async () => [
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
            getMemberChallenges: jest.fn(async () => [{ id: 1, join_coins: 0, type: 'flash', title: 'Timed' }]),
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
        const deps = makeDeps({ getMemberChallenges: jest.fn(async () => candidates()) });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.results[0].status).toBe('skipped:tag-out-of-scope');
        expect(res.results[1].status).toBe('joined');
    });

    test('a global exclude-list vetoes', async () => {
        settings.getEffectiveSetting.mockImplementation((k) =>
            k === 'autoJoinExcludeChallengeTags' ? 'comm' : DEFAULT_SETTINGS[k],
        );
        const deps = makeDeps({ getMemberChallenges: jest.fn(async () => candidates()) });
        const res = await runJoinPass('tok', Date.now(), deps);
        expect(res.results[0].status).toBe('joined');
        expect(res.results[1].status).toBe('skipped:excluded-tag');
    });

    test('the candidate object (not just its title) reaches the rule lookup', async () => {
        // A tag-keyed rule has no title to match on, so this only passes if the
        // pass hands the whole candidate to the facade.
        const seen = [];
        settings.resolveRuleSetting.mockImplementation((key, target) => {
            seen.push(target);
            return null;
        });
        const deps = makeDeps({ getMemberChallenges: jest.fn(async () => candidates()) });
        await runJoinPass('tok', Date.now(), deps);
        expect(seen.some((t) => Array.isArray(t?.tags) && t.tags.includes('Turbo'))).toBe(true);
    });

    test('a tag-keyed rule can set the join window for every challenge carrying that tag', async () => {
        const HOUR = 3600;
        const nowMs = 1_700_000_000_000;
        const nowSec = nowMs / 1000;
        rulesGive((target) => ((target?.tags || []).includes('Exhibition') ? { autoJoinWithinHoursOfEnd: 24 } : {}));
        const deps = makeDeps({
            getMemberChallenges: jest.fn(async () => [
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
            getMemberChallenges: jest.fn(async () => [{ id: 2, join_coins: 100, type: 'flash' }]),
        });
        const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: false });
        expect(res).toMatchObject({ status: 'needs-confirm', cost: 100 });
        expect(deps.coinsUnlock).not.toHaveBeenCalled();
    });

    test('unavailable when not in the open list', async () => {
        const deps = makeDeps({ getMemberChallenges: jest.fn(async () => []) });
        const res = await joinChallengeSingle(999, 'tok', deps, { spendCoins: true });
        expect(res.status).toBe('unavailable');
    });

    test('paid with spendCoins joins after affordability check', async () => {
        const deps = makeDeps({
            getMemberChallenges: jest.fn(async () => [{ id: 2, join_coins: 100, type: 'flash' }]),
            getBankroll: jest.fn(async () => ({ coins: 500 })),
        });
        const res = await joinChallengeSingle(2, 'tok', deps, { spendCoins: true });
        expect(res.status).toBe('joined');
        expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);
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
    const globalSetting = (map) =>
        settings.getEffectiveSetting.mockImplementation((k) =>
            Object.prototype.hasOwnProperty.call(map, k) ? map[k] : DEFAULT_SETTINGS[k],
        );

    test('a photo-count rule overrides the global window for its class', async () => {
        // Global says "only in the last hour" \u2014 this candidate has 4h left.
        globalSetting({ autoJoinWithinHoursOfEnd: 1 });
        // The rule widens it to 6h, so this one joins.
        rulesGive((target) => (target?.max_photo_submits === 4 ? { autoJoinWithinHoursOfEnd: 6 } : {}));
        const deps = makeDeps({ getMemberChallenges: jest.fn(async () => [candidate()]) });
        const res = await runJoinPass('tok', NOW_MS, deps);
        expect(res.joined).toBe(1);
        expect(deps.submitToChallenge).toHaveBeenCalled();
    });

    test('a class rule can also make the timing STRICTER than the global', async () => {
        globalSetting({ autoJoinWithinHoursOfEnd: 48 });
        rulesGive((target) => (target?.max_photo_submits === 4 ? { autoJoinWithinHoursOfEnd: 1 } : {}));
        const deps = makeDeps({ getMemberChallenges: jest.fn(async () => [candidate()]) });
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
        const deps = makeDeps({ getMemberChallenges: jest.fn(async () => [candidate()]) });
        const res = await runJoinPass('tok', NOW_MS, deps);
        expect(res.joined).toBe(1);
    });

    test('a percent rule defers a candidate that has not run long enough yet', async () => {
        globalSetting({ autoJoinWithinHoursOfEnd: 0 });
        rulesGive((target) => (target?.max_photo_submits === 4 ? { autoJoinAfterPercentElapsed: 90 } : {}));
        const deps = makeDeps({ getMemberChallenges: jest.fn(async () => [candidate()]) });
        const res = await runJoinPass('tok', NOW_MS, deps);
        expect(res.joined).toBe(0);
        expect(res.results[0].status).toBe('skipped:too-early');
    });

    test('the same percent anchor defers a long challenge and joins a short one', async () => {
        globalSetting({ autoJoinWithinHoursOfEnd: 0, autoJoinAfterPercentElapsed: 75 });
        const deps = makeDeps({
            getMemberChallenges: jest.fn(async () => [
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
            getMemberChallenges: jest.fn(async () => [candidate({ start_time: undefined })]),
        });
        const res = await runJoinPass('tok', NOW_MS, deps);
        expect(res.joined).toBe(0);
        expect(res.results[0].status).toBe('skipped:start-time-unknown');
        expect(deps.submitToChallenge).not.toHaveBeenCalled();
    });
});

describe('joinChallenges — edge paths', () => {
    const logger = require('../../src/js/logger');
    const autoFill = require('../../src/js/services/autoFill');
    const warnings = () => logger.withCategory().warning.mock.calls.map(([msg]) => msg);
    const errors = () => logger.withCategory().error.mock.calls.map(([msg]) => msg);

    describe('title matching', () => {
        test('a titleless candidate still consults the rules (they may key on tags, type, photos, runtime)', () => {
            rulesGive(() => ({ autoJoinMaxCoins: 7 }));
            expect(resolveJoinSetting('autoJoinMaxCoins', { tags: ['Exhibition'] })).toBe(7);
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
                getMemberChallenges: jest.fn(async () => [
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
            settings.getTitleRules.mockReturnValue({ not: 'a list' });
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
            const deps = makeDeps({ getMemberChallenges: jest.fn(async () => [null]) });
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
                const res = await performJoin({ id: 3 }, 'tok', deps, 100);
                expect(res).toEqual({ status: 'failed-no-charge', charged: 0 });
                expect(deps.coinsUnlock).not.toHaveBeenCalled();
                const text = thrown instanceof Error ? thrown.message : thrown;
                expect(warnings()).toContain(`could not read join-state: ${text}`);
            }
        });

        test('a join-state file that is valid JSON but not an object is unreadable → no spend', async () => {
            const deps = makeDeps({ joinStateStore: { readRaw: () => '[1,2]', writeRaw: jest.fn() } });
            expect(await performJoin({ id: 3 }, 'tok', deps, 100)).toEqual({ status: 'failed-no-charge', charged: 0 });
            expect(warnings()).toContain('join-state file is malformed (not an object) — treating as unreadable');
            expect(errors()).toContain('challenge 3: join-state is unreadable — not spending coins');
        });

        test('a failure to clear the marker after a successful join is logged, the join still succeeds', async () => {
            let raw = JSON.stringify({ 4: { unlockedAt: 1 } });
            const deps = makeDeps({
                joinStateStore: {
                    readRaw: () => raw,
                    writeRaw: jest.fn(() => {
                        throw new Error('read-only');
                    }),
                },
            });
            const res = await performJoin({ id: 4 }, 'tok', deps, 100);
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
            expect(await performJoin({ id: 4 }, 'tok', deps, 100)).toEqual({ status: 'failed-no-charge', charged: 0 });
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
            expect(warnings()).toContain('could not persist unlock marker for 4: disk full');
        });

        test('a non-Error thrown while clearing the marker is reported as-is', async () => {
            const deps = makeDeps({
                joinStateStore: {
                    readRaw: () => JSON.stringify({ 4: { unlockedAt: 1 } }),
                    writeRaw: () => {
                        throw 'nope';
                    },
                },
            });
            await performJoin({ id: 4 }, 'tok', deps, 100);
            expect(warnings()).toContain('could not clear unlock marker for 4: nope');
        });

        test('clearing when this challenge has no marker writes nothing', async () => {
            const writeRaw = jest.fn();
            const deps = makeDeps({ joinStateStore: { readRaw: () => JSON.stringify({ other: {} }), writeRaw } });
            expect((await performJoin({ id: 5 }, 'tok', deps, 0)).status).toBe('joined');
            expect(writeRaw).not.toHaveBeenCalled();
        });
    });

    describe('mock mode (no join-state store)', () => {
        test('a paid join with joinStateStore null unlocks and submits without persisting', async () => {
            const deps = makeDeps({ joinStateStore: null });
            expect(await performJoin({ id: 6 }, 'tok', deps, 50)).toEqual({
                status: 'joined',
                charged: 50,
                imageId: 'imgA',
            });
            expect(deps.coinsUnlock).toHaveBeenCalledWith(6, 'tok');
        });
    });

    describe('performJoin — remaining outcomes', () => {
        test('another process unlocked between the first check and the lock → submit only, no re-charge', async () => {
            const reads = [null, JSON.stringify({ 8: { unlockedAt: 1 } }), JSON.stringify({ 8: { unlockedAt: 1 } })];
            const deps = makeDeps({ joinStateStore: { readRaw: () => reads.shift() ?? null, writeRaw: jest.fn() } });
            const res = await performJoin({ id: 8 }, 'tok', deps, 100);
            expect(res).toMatchObject({ status: 'joined', charged: 0 });
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
            expect(deps.submitToChallenge).toHaveBeenCalledWith(8, ['imgA'], 'tok');
        });

        test('free join cancelled before submit → failed-no-charge', async () => {
            cancellation.isCancelled.mockReturnValue(true);
            const deps = makeDeps();
            expect(await performJoin({ id: 9 }, 'tok', deps, 0)).toEqual({ status: 'failed-no-charge', charged: 0 });
            expect(deps.submitToChallenge).not.toHaveBeenCalled();
        });

        test('free join whose submit fails → failed-no-charge', async () => {
            const deps = makeDeps({ submitToChallenge: jest.fn(async () => ({ ok: false })) });
            expect(await performJoin({ id: 9 }, 'tok', deps, 0)).toEqual({ status: 'failed-no-charge', charged: 0 });
        });

        test('a retried submit of an already-paid join that fails again stays pending, not re-charged', async () => {
            const deps = makeDeps({
                joinStateStore: { readRaw: () => JSON.stringify({ 10: { unlockedAt: 1 } }), writeRaw: jest.fn() },
                submitToChallenge: jest.fn(async () => null),
            });
            expect(await performJoin({ id: 10 }, 'tok', deps, 100)).toEqual({
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
                expect(await performJoin({ id: 11 }, 'tok', deps, 100)).toEqual({
                    status: 'skipped-no-photo',
                    charged: 0,
                });
                const text = thrown instanceof Error ? thrown.message : thrown;
                expect(warnings()).toContain(`could not read eligible photos for 11: ${text}`);
            }
        });

        test('a picker returning nothing at all is "no photo"', async () => {
            photoPicker.pickPhotosForChallenge.mockReturnValue(null);
            expect((await performJoin({ id: 12 }, 'tok', makeDeps(), 0)).status).toBe('skipped-no-photo');
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

        test('no open challenges → ran, nothing joined, no balance read', async () => {
            const deps = makeDeps({ getMemberChallenges: jest.fn(async () => []) });
            expect(await runJoinPass('tok', Date.now(), deps)).toEqual({ ran: true, joined: 0, results: [] });
            expect(deps.getBankroll).not.toHaveBeenCalled();
        });

        test('a non-Error thrown by the balance read is reported and paid joins are skipped', async () => {
            const deps = makeDeps({
                getMemberChallenges: jest.fn(async () => [{ id: 1, join_coins: 100, type: 'flash' }]),
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
                getMemberChallenges: jest.fn(async () => [
                    { id: 1, join_coins: 0, type: 'flash', close_time: closeSoon },
                ]),
            });
            expect((await runJoinPass('tok', undefined, deps)).joined).toBe(1);
        });

        test('cancellation stops the pass before the next candidate', async () => {
            cancellation.isCancelled.mockReturnValue(true);
            const deps = makeDeps({ getMemberChallenges: jest.fn(async () => [{ id: 1, join_coins: 0 }]) });
            expect(await runJoinPass('tok', Date.now(), deps)).toEqual({ ran: true, joined: 0, results: [] });
            expect(warnings()).toContain('join pass cancelled by user');
        });

        test('a numeric-string balance allows the paid join and is decremented for later candidates', async () => {
            // Budget (300) covers both joins, so only the balance can stop the second.
            const bankroll = { coins: '150' };
            const deps = makeDeps({
                getMemberChallenges: jest.fn(async () => [
                    { id: 1, join_coins: 100, type: 'flash' },
                    { id: 2, join_coins: 100, type: 'flash' },
                ]),
                getBankroll: jest.fn(async () => bankroll),
            });
            const res = await runJoinPass('tok', Date.now(), deps);
            expect(res.results[0]).toEqual({ id: 1, status: 'joined' });
            expect(res.results[1]).toEqual({ id: 2, status: 'skipped:insufficient-coins' });
            expect(deps.coinsUnlock).toHaveBeenCalledTimes(1);
            expect(bankroll.coins).toBe(50);
        });

        test('a candidate with no eligible photo is reported and not counted as joined', async () => {
            photoPicker.pickPhotosForChallenge.mockReturnValue([]);
            const deps = makeDeps({ getMemberChallenges: jest.fn(async () => [{ id: 1, join_coins: 0 }]) });
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
            const deps = makeDeps({ getMemberChallenges: jest.fn(async () => [{ id: 1, join_coins: 0 }]) });
            const res = await runJoinPass('tok', Date.now(), deps);
            expect(res.results).toEqual([{ id: 1, status: 'error' }]);
            expect(warnings()).toContain('join failed for challenge 1: picker boom');
        });
    });

    describe('joinChallengeSingle — remaining outcomes', () => {
        const paid = () => jest.fn(async () => [{ id: 2, join_coins: 100, type: 'flash' }]);

        test('no token → not-authenticated without any API call', async () => {
            const deps = makeDeps();
            expect(await joinChallengeSingle(2, null, deps)).toEqual({
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

        test('a null listing → unavailable', async () => {
            const deps = makeDeps({ getMemberChallenges: jest.fn(async () => null) });
            expect((await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).status).toBe('unavailable');
        });

        test.each([[null], [{}], [{ coins: 'lots' }]])('bankroll %p → balance-unknown, no spend', async (bankroll) => {
            const deps = makeDeps({ getMemberChallenges: paid(), getBankroll: jest.fn(async () => bankroll) });
            expect(await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).toEqual({
                status: 'balance-unknown',
                challengeId: 2,
                cost: 100,
            });
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
        });

        test('not enough coins → skipped-unaffordable with the balance', async () => {
            const deps = makeDeps({ getMemberChallenges: paid(), getBankroll: jest.fn(async () => ({ coins: 40 })) });
            expect(await joinChallengeSingle(2, 'tok', deps, { spendCoins: true })).toEqual({
                status: 'skipped-unaffordable',
                challengeId: 2,
                cost: 100,
                coins: 40,
            });
            expect(deps.coinsUnlock).not.toHaveBeenCalled();
        });

        test('a free challenge joins without reading the balance', async () => {
            const deps = makeDeps({ getMemberChallenges: jest.fn(async () => [{ id: 3, join_coins: 'free' }]) });
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
