/**
 * get-library-photos: argument validation before the token lookup, the mapped
 * fields only, the no-`c_id` fallback (a borrowed challenge, `allowedKnown:
 * false`, or a distinct refusal), and the throttle — one walk at a time, a
 * newer request replacing a queued one, a minimum gap between walks.
 */

jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/apiFactory');
jest.mock('../../src/ts/services/auth');
jest.mock('../../src/ts/services/autoFill');

import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import apiFactoryModule = require('../../src/ts/apiFactory');
const apiFactory = jest.mocked(apiFactoryModule);
import authModule = require('../../src/ts/services/auth');
const auth = jest.mocked(authModule);
import autoFillModule = require('../../src/ts/services/autoFill');
const autoFill = jest.mocked(autoFillModule);
import type * as libraryModule from '../../src/ts/ipc/actions/library';
import { invalid } from '../helpers/invalid';
import { logCategories } from '../helpers/logCategories';

const { handleGetLibraryPhotos, __resetLibraryThrottle, MIN_WALK_INTERVAL_MS } =
    require('../../src/ts/ipc/actions/library') as typeof libraryModule;

// The handler is invoked the way ipcMain does: the event first.
const call = (...args: unknown[]) =>
    (handleGetLibraryPhotos as (...a: unknown[]) => ReturnType<typeof handleGetLibraryPhotos>)({}, ...args);

const rawPhoto = {
    id: 'p1',
    labels: ['Pink', 7, 'x'.repeat(100)],
    permission: { allowed: true, message: 'ok'.repeat(200) },
    upload_date: 1234,
    votes: 99,
    secret: 'never forwarded',
    member_id: 'm9',
};

type WalkResult = { items: unknown[]; truncated: boolean };
type Walk = jest.Mock<Promise<WalkResult>, [string | number, string, { search?: string; logLabel?: string }]>;
const newWalk = (result: WalkResult = { items: [rawPhoto], truncated: false }): Walk =>
    jest.fn<Promise<WalkResult>, [string | number, string, { search?: string; logLabel?: string }]>(async () => result);

const stubStrategy = (
    over: {
        getActiveChallenges?: jest.Mock<Promise<unknown>, [string]>;
        getEligiblePhotosWalk?: Walk;
    } = {},
) => {
    const strategy = {
        getActiveChallenges: jest.fn<Promise<unknown>, [string]>(async () => ({ challenges: [{ id: 'active-1' }] })),
        getEligiblePhotosWalk: newWalk(),
        getCurrentMemberProfile: jest.fn(),
        ...over,
    };
    apiFactory.getApiStrategy = jest.fn().mockReturnValue(strategy);
    return strategy;
};

beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    __resetLibraryThrottle();
    auth.requireAuthToken = jest.fn().mockReturnValue({ ok: true, token: 'tok', settings: {} });
    autoFill.resolveMemberId = jest.fn().mockResolvedValue('member-1');
    settings.getOpenChallengeIds = jest.fn().mockReturnValue(null);
});

describe('validation', () => {
    test.each([
        ['a challenge id that is not an id', [{}]],
        ['an empty challenge id', ['  ']],
        ['an over-long challenge id', ['9'.repeat(65)]],
        ['a search that is not text', ['5', 12]],
    ])('refuses %s before looking up the token', async (_name, args) => {
        const strategy = stubStrategy();
        await expect(call(...args)).resolves.toEqual({ success: false, error: 'invalid-args' });
        expect(auth.requireAuthToken).not.toHaveBeenCalled();
        expect(strategy.getEligiblePhotosWalk).not.toHaveBeenCalled();
        expect(logCategories('warning', 'Refused get-library-photos: invalid id argument', null)).toEqual(['autoFill']);
    });

    test('answers the auth guard when signed out', async () => {
        auth.requireAuthToken = jest
            .fn()
            .mockReturnValue({ ok: false, response: { success: false, error: 'No token' } });
        stubStrategy();
        await expect(call('5')).resolves.toEqual({ success: false, error: 'No token' });
    });

    test('the search term is stripped of control characters, trimmed and capped; nothing left means no search', async () => {
        const strategy = stubStrategy();
        await call('5', `  \u0007sun\u001b[31mset\nbeach${'x'.repeat(80)}  `);
        const sent = strategy.getEligiblePhotosWalk.mock.calls[0][2].search as string;
        expect(sent).toHaveLength(50);
        expect(sent.startsWith('sun[31msetbeachxxx')).toBe(true);
        __resetLibraryThrottle();
        await call('5', ' \u0007 ');
        expect(strategy.getEligiblePhotosWalk.mock.calls[1][2].search).toBeUndefined();
        __resetLibraryThrottle();
        await call('5', null);
        expect(strategy.getEligiblePhotosWalk.mock.calls[2][2].search).toBeUndefined();
    });
});

describe('the listing', () => {
    test('maps the fields the chooser needs and nothing else', async () => {
        const strategy = stubStrategy({
            getEligiblePhotosWalk: jest
                .fn()
                .mockResolvedValue({ items: [rawPhoto, invalid({ id: 5 })], truncated: true }),
        });
        const result = await call(5, 'pink');
        expect(strategy.getEligiblePhotosWalk).toHaveBeenCalledWith(5, 'tok', { search: 'pink', logLabel: 'library' });
        expect(result).toEqual({
            success: true,
            photos: [
                {
                    id: 'p1',
                    labels: ['Pink', 'x'.repeat(80)],
                    allowed: true,
                    message: 'ok'.repeat(100),
                    uploadDate: 1234,
                },
                { id: '5', labels: [], allowed: false, message: null, uploadDate: null },
            ],
            memberId: 'member-1',
            truncated: true,
            allowedKnown: true,
        });
        expect(autoFill.resolveMemberId).toHaveBeenCalledWith(
            'tok',
            strategy.getCurrentMemberProfile,
            expect.anything(),
            'library',
        );
    });

    test('caps the labels per photo', async () => {
        stubStrategy({
            getEligiblePhotosWalk: newWalk({
                items: [{ id: 'many', labels: Array.from({ length: 50 }, (_, i) => `l${i}`) }],
                truncated: false,
            }),
        });
        const result = (await call(5)) as { photos: Array<{ labels: string[] }> };
        expect(result.photos[0].labels).toHaveLength(32);
    });

    test('an unknown member is null', async () => {
        stubStrategy();
        autoFill.resolveMemberId = jest.fn().mockResolvedValue(null);
        await expect(call(5)).resolves.toMatchObject({ success: true, memberId: null });
    });

    test('a failing read is an error result, never a throw', async () => {
        stubStrategy({ getEligiblePhotosWalk: newWalk().mockRejectedValue(new Error('library down')) });
        await expect(call(5)).resolves.toEqual({ success: false, error: 'library down' });
        stubStrategy({ getEligiblePhotosWalk: newWalk().mockRejectedValue(new Error('')) });
        __resetLibraryThrottle();
        await expect(call(5)).resolves.toEqual({ success: false, error: 'Failed to read your photo library' });
    });
});

describe('without a challenge id (get_photos_private needs one)', () => {
    test('borrows an active challenge and says the allowed flags do not apply', async () => {
        const strategy = stubStrategy();
        const result = await call();
        expect(strategy.getEligiblePhotosWalk).toHaveBeenCalledWith('active-1', 'tok', expect.anything());
        expect(result).toMatchObject({ success: true, allowedKnown: false });
        // null means the same as absent.
        __resetLibraryThrottle();
        await expect(call(null, null)).resolves.toMatchObject({ allowedKnown: false });
    });

    test('skips an active challenge without a usable id, then falls back to an open one', async () => {
        const strategy = stubStrategy({
            getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [{ id: '' }, invalid({})] }),
        });
        settings.getOpenChallengeIds = jest.fn().mockReturnValue(new Set(['open-9', 'open-10']));
        await call();
        expect(strategy.getEligiblePhotosWalk).toHaveBeenCalledWith('open-9', 'tok', expect.anything());
    });

    test.each([
        ['no active and no open challenge', { challenges: [] }, null],
        ['an unreadable active list and an empty open list', null, new Set<string>()],
    ])('with %s it refuses with a distinct reason', async (_name, active, open) => {
        const strategy = stubStrategy({ getActiveChallenges: jest.fn().mockResolvedValue(active) });
        settings.getOpenChallengeIds = jest.fn().mockReturnValue(open);
        await expect(call()).resolves.toEqual({ success: false, error: 'no-challenge-context' });
        expect(strategy.getEligiblePhotosWalk).not.toHaveBeenCalled();
    });
});

describe('the throttle', () => {
    const deferred = <T>() => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((r) => (resolve = r));
        return { promise, resolve };
    };
    const walkResult = { items: [rawPhoto], truncated: false };

    test('one walk at a time; a newer request replaces a queued one; a minimum gap separates walks', async () => {
        jest.useFakeTimers();
        const first = deferred<typeof walkResult>();
        const third = deferred<typeof walkResult>();
        const walk = newWalk().mockReturnValueOnce(first.promise).mockReturnValueOnce(third.promise);
        stubStrategy({ getEligiblePhotosWalk: walk });

        const one = call(1);
        const two = call(2, 'a');
        const three = call(3, 'b');
        // The replaced request is answered at once; only the first walk is running.
        await expect(two).resolves.toEqual({ success: false, error: 'superseded' });
        expect(walk).toHaveBeenCalledTimes(1);

        first.resolve(walkResult);
        await expect(one).resolves.toMatchObject({ success: true });
        // The queued request waits out the minimum gap...
        await jest.advanceTimersByTimeAsync(MIN_WALK_INTERVAL_MS - 1);
        expect(walk).toHaveBeenCalledTimes(1);
        // ...then runs, and it is the NEWER request that runs.
        await jest.advanceTimersByTimeAsync(1);
        expect(walk).toHaveBeenCalledTimes(2);
        expect(walk.mock.calls[1][0]).toBe(3);
        third.resolve(walkResult);
        await expect(three).resolves.toMatchObject({ success: true });
    });

    test('a request arriving during the gap replaces the one already waiting, and a lone request after it runs at once', async () => {
        jest.useFakeTimers();
        const walk = newWalk();
        stubStrategy({ getEligiblePhotosWalk: walk });
        await call(1);
        // Inside the gap: two requests queue behind the timer, the second replaces the first.
        const early = call(2);
        const newer = call(3);
        await expect(early).resolves.toEqual({ success: false, error: 'superseded' });
        await jest.advanceTimersByTimeAsync(MIN_WALK_INTERVAL_MS);
        await expect(newer).resolves.toMatchObject({ success: true });
        expect(walk.mock.calls.map((c) => c[0])).toEqual([1, 3]);
        // Long after the last walk there is no gap to wait for.
        await jest.advanceTimersByTimeAsync(MIN_WALK_INTERVAL_MS * 4);
        await call(4);
        expect(walk).toHaveBeenCalledTimes(3);
    });
});
