/**
 * The Discover handlers' identity lookup, against the real member-identity cache: one lookup per
 * token on a cold cache, none on a warm one, and a failed lookup is retried at most every 60 s.
 * (actions.handlers.test.ts mocks the fill module, so it cannot see the cache.)
 */

jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/apiFactory');
jest.mock('../../src/ts/services/auth');
jest.mock('../../src/ts/windows/quitGuard', () => ({ rememberChallenges: jest.fn() }));

import { invalid } from '../helpers/invalid';
import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import apiFactoryModule = require('../../src/ts/apiFactory');
const apiFactory = jest.mocked(apiFactoryModule);
import authModule = require('../../src/ts/services/auth');
const auth = jest.mocked(authModule);
import type * as autoFillModule from '../../src/ts/services/autoFill';
import type * as actionsHandlersModule from '../../src/ts/ipc/actions.handlers';
import type * as openChallengeCacheModule from '../../src/ts/services/openChallengeCache';
import type { Challenge } from '../../src/ts/types/gurushots';
const { __resetMemberIdCache } = require('../../src/ts/services/autoFill') as typeof autoFillModule;
const { buildHandlers } = require('../../src/ts/ipc/actions.handlers') as typeof actionsHandlersModule;
const { clearOpenChallenges } = require('../../src/ts/services/openChallengeCache') as typeof openChallengeCacheModule;

const OWNER = 'member-0';
let getCurrentMemberProfile: jest.MockedFunction<() => Promise<{ id: string } | null>>;

const annotate = (ids: number[] = [7]) =>
    invalid<(event: unknown, ids: unknown) => Promise<unknown>>(buildHandlers()['get-open-chosen-annotations'])(
        {},
        ids,
    );
const list = () => buildHandlers()['get-member-challenges']({});

beforeEach(() => {
    __resetMemberIdCache();
    clearOpenChallenges();
    getCurrentMemberProfile = jest.fn();
    getCurrentMemberProfile.mockResolvedValue({ id: OWNER });
    apiFactory.getApiStrategy = jest.fn().mockReturnValue({
        getCurrentMemberProfile,
        getMemberChallenges: jest.fn().mockResolvedValue([invalid<Challenge>({ id: 7 })]),
    });
    auth.requireAuthToken = jest.fn().mockReturnValue({ ok: true, token: 'tok', settings: {} });
    jest.mocked(settings.loadSettings).mockReturnValue(invalid({ token: 'tok' }));
    jest.mocked(settings.getSetting).mockReturnValue(invalid(OWNER));
    jest.mocked(settings.getChallengeOverride).mockReturnValue(invalid(['a', 'b']));
    jest.mocked(settings.resolveRuleSetting).mockReturnValue(invalid(null));
    jest.mocked(settings.getEffectiveSetting).mockReturnValue(invalid([]));
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe.each([
    ['get-open-chosen-annotations', () => annotate([7, 8, 9])],
    ['get-member-challenges', list],
])('%s', (_name, call) => {
    test('a cold cache looks the member up exactly once, however many rows or calls follow', async () => {
        await call();
        expect(getCurrentMemberProfile).toHaveBeenCalledTimes(1);
        expect(getCurrentMemberProfile).toHaveBeenCalledWith('tok');
    });

    test('a warm cache makes no request at all, and the ids come through for the owner', async () => {
        await call();
        getCurrentMemberProfile.mockClear();
        const result = await call();
        expect(getCurrentMemberProfile).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).toContain('"chosenOwn":["a","b"]');
    });

    test('a failed lookup is not repeated for 60 s, then tried again; the ids stay withheld meanwhile', async () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
        getCurrentMemberProfile.mockResolvedValue(null);
        const first = await call();
        await call();
        expect(getCurrentMemberProfile).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(first)).toContain('"chosenOwn":[]');
        expect(JSON.stringify(first)).not.toContain('"a"');
        now.mockReturnValue(1_000_000 + 61_000);
        await call();
        expect(getCurrentMemberProfile).toHaveBeenCalledTimes(2);
    });
});

test('both handlers racing on a cold cache share one lookup', async () => {
    await Promise.all([annotate([7, 8, 9]), list()]);
    expect(getCurrentMemberProfile).toHaveBeenCalledTimes(1);
});

describe('confirm-account: the explicit retry after a failed identity lookup', () => {
    const confirm = () => buildHandlers()['confirm-account']();
    let walk: jest.MockedFunction<() => Promise<unknown>>;

    beforeEach(() => {
        walk = jest.fn();
        apiFactory.getApiStrategy = jest.fn().mockReturnValue({
            getCurrentMemberProfile,
            getEligiblePhotosWalk: walk,
            getMemberChallenges: jest.fn(),
        });
    });

    test('a failed lookup is evicted, so the retry succeeds at once instead of waiting out the 60 s, with no library walk', async () => {
        jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
        getCurrentMemberProfile.mockResolvedValueOnce(null);
        await annotate();
        // The cached failure answers any ordinary resolve for the next minute...
        await annotate();
        expect(getCurrentMemberProfile).toHaveBeenCalledTimes(1);

        // ...but an explicit retry asks again, however recent the failure, and this time it works.
        await expect(confirm()).resolves.toEqual({ success: true, memberId: OWNER });
        expect(getCurrentMemberProfile).toHaveBeenCalledTimes(2);
        expect(walk).not.toHaveBeenCalled();
        // The member is cached now: the rows get their ids with no further request.
        getCurrentMemberProfile.mockClear();
        expect(JSON.stringify(await annotate())).toContain('"chosenOwn":["a","b"]');
        expect(getCurrentMemberProfile).not.toHaveBeenCalled();
    });

    test('a lookup that fails again says so; presses within the gap share the cached failure, one after it asks again', async () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
        getCurrentMemberProfile.mockResolvedValue(null);
        await expect(confirm()).resolves.toEqual({ success: false, error: 'account-check-failed' });
        // Two quick presses make no further request: the failure just cached answers them.
        now.mockReturnValue(1_000_000 + 1_000);
        await expect(confirm()).resolves.toEqual({ success: false, error: 'account-check-failed' });
        await expect(confirm()).resolves.toEqual({ success: false, error: 'account-check-failed' });
        expect(getCurrentMemberProfile).toHaveBeenCalledTimes(1);
        // Past the gap a press asks again, and a success then goes through.
        now.mockReturnValue(1_000_000 + 6_000);
        getCurrentMemberProfile.mockResolvedValueOnce({ id: OWNER });
        await expect(confirm()).resolves.toEqual({ success: true, memberId: OWNER });
        expect(getCurrentMemberProfile).toHaveBeenCalledTimes(2);
    });

    test('the first explicit Retry right after a failed lookup asks at once; a second inside the gap does not', async () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(3_000_000);
        getCurrentMemberProfile.mockResolvedValue(null);
        await annotate();
        expect(getCurrentMemberProfile).toHaveBeenCalledTimes(1);

        // The lookup failed a moment ago, and the user presses Retry: it makes a request (which fails again).
        now.mockReturnValue(3_000_000 + 100);
        await expect(confirm()).resolves.toEqual({ success: false, error: 'account-check-failed' });
        expect(getCurrentMemberProfile).toHaveBeenCalledTimes(2);

        // A second press inside the gap, counted from that Retry, shares the cached failure.
        now.mockReturnValue(3_000_000 + 100 + 4_999);
        await confirm();
        expect(getCurrentMemberProfile).toHaveBeenCalledTimes(2);
        // Presses inside the gap do not push it back: one at the gap goes through.
        now.mockReturnValue(3_000_000 + 100 + 5_000);
        await confirm();
        expect(getCurrentMemberProfile).toHaveBeenCalledTimes(3);
    });

    test('a resolved member is never looked up again, and a lookup in flight is shared, not evicted', async () => {
        await annotate();
        getCurrentMemberProfile.mockClear();
        await expect(confirm()).resolves.toEqual({ success: true, memberId: OWNER });
        expect(getCurrentMemberProfile).not.toHaveBeenCalled();

        __resetMemberIdCache();
        const inFlight = annotate();
        await expect(confirm()).resolves.toEqual({ success: true, memberId: OWNER });
        await inFlight;
        expect(getCurrentMemberProfile).toHaveBeenCalledTimes(1);
    });

    test('signed out is its own answer, not a failed check, and a throwing lookup is an error result', async () => {
        auth.requireAuthToken = jest
            .fn()
            .mockReturnValue({ ok: false, response: { success: false, error: 'no token' } });
        await expect(confirm()).resolves.toEqual({ success: false, error: 'not-logged-in' });
        expect(getCurrentMemberProfile).not.toHaveBeenCalled();
        auth.requireAuthToken = jest.fn().mockReturnValue({ ok: true, token: 'tok', settings: {} });
        apiFactory.getApiStrategy = jest.fn(() => {
            throw new Error('settings broke');
        });
        await expect(confirm()).resolves.toEqual({ success: false, error: 'settings broke' });
    });
});
