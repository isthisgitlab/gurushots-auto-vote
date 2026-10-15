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
import type * as libraryCacheModule from '../../src/ts/services/libraryCache';
import type * as accountScopeModule from '../../src/ts/services/accountScope';
import type { LibraryPhoto } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';
import { logCategories } from '../helpers/logCategories';

const { handleGetLibraryPhotos, hasWonChallenge, __resetLibraryThrottle, MIN_WALK_INTERVAL_MS } =
    require('../../src/ts/ipc/actions/library') as typeof libraryModule;
const { clearLibraryCache, dropContext, LIBRARY_FRESH_MS } =
    require('../../src/ts/services/libraryCache') as typeof libraryCacheModule;
const { bumpAccountGeneration } = require('../../src/ts/services/accountScope') as typeof accountScopeModule;

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

type WalkResult = { items: unknown[]; truncated: boolean; skipped?: string[] };
type WalkOptions = { search?: string; logLabel?: string; skip?: (photo: LibraryPhoto) => boolean };
type Walk = jest.Mock<Promise<WalkResult>, [string | number, string, WalkOptions]>;
const newWalk = (result: WalkResult = { items: [rawPhoto], truncated: false }): Walk =>
    jest.fn<Promise<WalkResult>, [string | number, string, WalkOptions]>(async () => result);

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
};

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
    clearLibraryCache();
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
        expect(logCategories('warning', 'Refused get-library-photos: invalid id argument', null)).toEqual([
            'autoSubmit',
        ]);
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
        expect(strategy.getEligiblePhotosWalk).toHaveBeenCalledWith(5, 'tok', {
            search: 'pink',
            logLabel: 'library',
            skip: hasWonChallenge,
        });
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
            wonIds: [],
            wonCount: 0,
            truncated: true,
            allowedKnown: true,
            preview: false,
            readAtMs: expect.any(Number),
        });
        expect(autoFill.resolveMemberId).toHaveBeenCalledWith(
            'tok',
            strategy.getCurrentMemberProfile,
            expect.anything(),
            'library',
        );
    });

    test('the reason a photo cannot enter comes as plain text, whatever HTML the server sent, and is capped after that', async () => {
        stubStrategy({
            getEligiblePhotosWalk: newWalk({
                items: [
                    {
                        id: 'b1',
                        permission: {
                            allowed: false,
                            message: 'Used <b>in</b> another<br/>challenge &amp; <i>more</i> &lt;b&gt;',
                        },
                    },
                    { id: 'b2', permission: { allowed: false, message: `<span>${'x'.repeat(300)}</span>` } },
                ],
                truncated: false,
            }),
        });
        const result = (await call(5)) as { photos: Array<{ message: string }> };
        expect(result.photos[0].message).toBe('Used in another — challenge & more <b>');
        expect(result.photos[1].message).toBe('x'.repeat(200));
    });

    test('the photos the walk left out for having won a challenge are reported by id, safe ids only, at most 1000, and counted in full', async () => {
        const skipped = ['has space', 'a/b', ...Array.from({ length: 1005 }, (_, i) => `w${i}`)];
        stubStrategy({ getEligiblePhotosWalk: newWalk({ items: [rawPhoto], truncated: false, skipped }) });
        const result = (await call(5)) as { wonIds: string[]; wonCount: number };
        // The unsafe ids lead the walk's list and are dropped, and the cap still fills with safe ones.
        expect(result.wonIds).toHaveLength(1000);
        expect(result.wonIds[0]).toBe('w0');
        expect(result.wonIds).not.toContain('has space');
        // wonCount is what the walk recorded, unsafe and over-cap ids included.
        expect(result.wonCount).toBe(1007);
        stubStrategy({ getEligiblePhotosWalk: newWalk({ items: [rawPhoto], truncated: false, skipped: ['a/b'] }) });
        __resetLibraryThrottle();
        expect(await call(5)).toMatchObject({ wonIds: [], wonCount: 1 });
    });

    test('a reason is converted from its first 800 characters at most, and what shows is capped at 200 after that', async () => {
        stubStrategy({
            getEligiblePhotosWalk: newWalk({
                items: [
                    { id: 'b1', permission: { allowed: false, message: `${'<b></b> '.repeat(100)}tail` } },
                    { id: 'b2', permission: { allowed: false, message: `${'x'.repeat(790)}<b>yy</b>zz` } },
                ],
                truncated: false,
            }),
        });
        const result = (await call(5)) as { photos: Array<{ message: string }> };
        // 100 empty tags are 800 characters: the text after them is never reached.
        expect(result.photos[0].message).toBe('');
        // The cut falls inside the markup: the half tag is left as it is.
        expect(result.photos[1].message).toBe(`${'x'.repeat(790)}yy`.slice(0, 200));
        expect(result.photos[1].message).toHaveLength(200);
    });

    test('a library read through a borrowed challenge leaves won photos out too: a won photo is barred from every challenge', async () => {
        const strategy = stubStrategy();
        await call(undefined, null);
        expect(strategy.getEligiblePhotosWalk).toHaveBeenCalledWith(
            'active-1',
            'tok',
            expect.objectContaining({ skip: hasWonChallenge }),
        );
    });

    test('photos whose id is not a safe token are not listed', async () => {
        stubStrategy({
            getEligiblePhotosWalk: newWalk({
                items: [{ id: 'ok_id-1' }, { id: 'has space' }, { id: 'x'.repeat(65) }, { id: 'a/b' }, { id: 7 }],
                truncated: false,
            }),
        });
        const result = (await call(5)) as { photos: Array<{ id: string }> };
        expect(result.photos.map((photo) => photo.id)).toEqual(['ok_id-1', '7']);
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
    test('borrowing a challenge is part of the throttled job: a replaced request never looks one up', async () => {
        jest.useFakeTimers();
        const strategy = stubStrategy();
        await call();
        expect(strategy.getActiveChallenges).toHaveBeenCalledTimes(1);
        // Inside the gap two requests queue; only the newer one runs, and only it borrows.
        const early = call();
        const newer = call();
        await expect(early).resolves.toEqual({ success: false, error: 'superseded' });
        expect(strategy.getActiveChallenges).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(MIN_WALK_INTERVAL_MS);
        await expect(newer).resolves.toMatchObject({ success: true, allowedKnown: false });
        expect(strategy.getActiveChallenges).toHaveBeenCalledTimes(2);
    });

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

describe('the library cache', () => {
    const listed = (...ids: string[]) => ({
        items: ids.map((id) => ({ id, labels: [`tag-${id}`], permission: { allowed: false, message: `No ${id}` } })),
        truncated: false,
        skipped: ['won-1', 'won-2'],
    });
    const idsOf = (result: unknown) => (result as { photos: Array<{ id: string }> }).photos.map((photo) => photo.id);
    const next = async (...args: unknown[]) => {
        __resetLibraryThrottle();
        return call(...args);
    };

    test('a no-search read is kept, and a cached request for that challenge answers it with its marks and no walk', async () => {
        const walk = newWalk(listed('a', 'b'));
        stubStrategy({ getEligiblePhotosWalk: walk });
        const read = (await call('5')) as { readAtMs: number };
        const cached = await next('5', undefined, 'cached');
        expect(walk).toHaveBeenCalledTimes(1);
        expect(cached).toMatchObject({
            success: true,
            preview: false,
            allowedKnown: true,
            readAtMs: read.readAtMs,
            wonCount: 2,
            wonIds: ['won-1', 'won-2'],
        });
        expect((cached as { photos: unknown[] }).photos[0]).toMatchObject({ allowed: false, message: 'No a' });
        // The request-less read asked the same, whatever number or text the id was given as.
        await expect(next(5, null, 'cached')).resolves.toMatchObject({ preview: false });
        expect(walk).toHaveBeenCalledTimes(1);
    });

    test('a request without a mode, or with mode fresh, walks every time', async () => {
        const walk = newWalk(listed('a'));
        stubStrategy({ getEligiblePhotosWalk: walk });
        await call('5');
        await next('5');
        await next('5', undefined, 'fresh');
        expect(walk).toHaveBeenCalledTimes(3);
    });

    test('another challenge, or an expired entry, answers the newest listing as a preview with its marks withheld and the won photos kept', async () => {
        const walk = newWalk({ ...listed('a', 'b'), skipped: ['won-1'] });
        stubStrategy({ getEligiblePhotosWalk: walk });
        await call('5');
        for (const challenge of ['6', null]) {
            const preview = (await next(challenge, undefined, 'cached')) as {
                photos: Array<{ allowed: boolean; message: string | null; labels: string[] }>;
            };
            expect(preview).toMatchObject({ success: true, preview: true, allowedKnown: false, wonCount: 1 });
            expect(preview.photos.map((photo) => [photo.allowed, photo.message])).toEqual([
                [false, null],
                [false, null],
            ]);
            expect(preview.photos[0].labels).toEqual(['tag-a']);
            // None of the reasons the other challenge gave is in what was sent.
            expect(JSON.stringify(preview)).not.toContain('No a');
        }
        expect(walk).toHaveBeenCalledTimes(1);
    });

    test('an entry answers for LIBRARY_FRESH_MS and is a preview from then on', async () => {
        jest.useFakeTimers({ now: 1_000_000 });
        const walk = newWalk(listed('a'));
        stubStrategy({ getEligiblePhotosWalk: walk });
        await call('5');
        jest.setSystemTime(1_000_000 + LIBRARY_FRESH_MS - 1);
        await expect(next('5', undefined, 'cached')).resolves.toMatchObject({ preview: false });
        jest.setSystemTime(1_000_000 + LIBRARY_FRESH_MS);
        await expect(next('5', undefined, 'cached')).resolves.toMatchObject({ preview: true, allowedKnown: false });
        expect(walk).toHaveBeenCalledTimes(1);
    });

    test('with nothing cached a cached request walks, and keeps what the walk read', async () => {
        const walk = newWalk(listed('a'));
        stubStrategy({ getEligiblePhotosWalk: walk });
        await expect(call('5', undefined, 'cached')).resolves.toMatchObject({ success: true, preview: false });
        expect(walk).toHaveBeenCalledTimes(1);
        await expect(next('5', undefined, 'cached')).resolves.toMatchObject({ preview: false });
        expect(walk).toHaveBeenCalledTimes(1);
    });

    test('a read with no challenge is kept for the no-challenge chooser only, not for the challenge it borrowed', async () => {
        const walk = newWalk(listed('a'));
        stubStrategy({ getEligiblePhotosWalk: walk });
        await call(undefined, null);
        expect(walk).toHaveBeenCalledWith('active-1', 'tok', expect.anything());
        await expect(next(undefined, null, 'cached')).resolves.toMatchObject({ preview: false, allowedKnown: false });
        await expect(next('active-1', null, 'cached')).resolves.toMatchObject({ preview: true });
        expect(walk).toHaveBeenCalledTimes(1);
    });

    test('a search is never kept, and a cached request with a search walks even with an entry for the challenge', async () => {
        const walk = newWalk(listed('a'));
        stubStrategy({ getEligiblePhotosWalk: walk });
        await call('5', 'pink');
        await expect(next('5', undefined, 'cached')).resolves.toMatchObject({ preview: false });
        expect(walk).toHaveBeenCalledTimes(2);
        await expect(next('5', 'pink', 'cached')).resolves.toMatchObject({ preview: false });
        expect(walk).toHaveBeenCalledTimes(3);
        expect(walk.mock.calls[2][2]).toMatchObject({ search: 'pink' });
        // Whitespace is no search: it is the no-search listing.
        await expect(next('5', '   ', 'cached')).resolves.toMatchObject({ preview: false });
        expect(walk).toHaveBeenCalledTimes(3);
    });

    test('a failed read, one with no challenge to read through and one that was replaced write nothing', async () => {
        const failing = jest
            .fn<Promise<WalkResult>, [string | number, string, WalkOptions]>()
            .mockRejectedValue(new Error('down'));
        stubStrategy({ getEligiblePhotosWalk: failing });
        await expect(call('5')).resolves.toMatchObject({ success: false });
        const walk = newWalk(listed('a'));
        stubStrategy({
            getEligiblePhotosWalk: walk,
            getActiveChallenges: jest.fn<Promise<unknown>, [string]>(async () => ({ challenges: [] })),
        });
        await expect(next(undefined, null)).resolves.toEqual({ success: false, error: 'no-challenge-context' });
        stubStrategy({ getEligiblePhotosWalk: walk });
        await expect(next('5', undefined, 'cached')).resolves.toMatchObject({ preview: false });
        expect(walk).toHaveBeenCalledTimes(1);
        // The failed read left nothing for the next cached request, which therefore walked.
        const first = call('6');
        const replaced = call('7');
        await expect(first).resolves.toEqual({ success: false, error: 'superseded' });
        await replaced;
    });

    test('a read that kept nothing and was cut short is not kept', async () => {
        const cutShort = newWalk({ items: [], truncated: true });
        stubStrategy({ getEligiblePhotosWalk: cutShort });
        await expect(call('5')).resolves.toMatchObject({ success: true, photos: [], truncated: true });
        await next('5', undefined, 'cached');
        expect(cutShort).toHaveBeenCalledTimes(2);
        // A complete empty library, and a cut-short read that did see won photos, are kept.
        const empty = newWalk({ items: [], truncated: false });
        stubStrategy({ getEligiblePhotosWalk: empty });
        await next('6');
        await next('6', undefined, 'cached');
        expect(empty).toHaveBeenCalledTimes(1);
        const onlyWon = newWalk({ items: [], truncated: true, skipped: ['w'] });
        stubStrategy({ getEligiblePhotosWalk: onlyWon });
        await next('7');
        await next('7', undefined, 'cached');
        expect(onlyWon).toHaveBeenCalledTimes(1);
    });

    test('a cached answer does not queue behind, supersede or wait for a walk in flight', async () => {
        const walk = newWalk(listed('a'));
        stubStrategy({ getEligiblePhotosWalk: walk });
        await call('5');
        const slow = deferred<WalkResult>();
        walk.mockReturnValueOnce(slow.promise);
        __resetLibraryThrottle();
        const running = call('6');
        // Another cached request is answered at once, from the cache, while the walk is pending...
        await expect(call('5', undefined, 'cached')).resolves.toMatchObject({ preview: false });
        await expect(call('9', undefined, 'cached')).resolves.toMatchObject({ preview: true });
        // ...and the walk was not replaced by either.
        slow.resolve(listed('z'));
        await expect(running).resolves.toMatchObject({ success: true, preview: false });
    });

    test('a cached answer is a copy: changing it never changes what is kept', async () => {
        stubStrategy({ getEligiblePhotosWalk: newWalk(listed('a')) });
        await call('5');
        const first = (await next('5', undefined, 'cached')) as { photos: Array<{ id: string; labels: string[] }> };
        first.photos[0].id = 'changed';
        first.photos[0].labels.push('changed');
        first.photos.push({ id: 'extra', labels: [] });
        const second = (await next('5', undefined, 'cached')) as typeof first;
        expect(second.photos).toEqual([expect.objectContaining({ id: 'a', labels: ['tag-a'] })]);
    });

    test('a walk in flight when the account leaves writes nothing and answers account-changed, never the old photos', async () => {
        const slow = deferred<WalkResult>();
        const walk = newWalk();
        walk.mockReturnValueOnce(slow.promise);
        stubStrategy({ getEligiblePhotosWalk: walk });
        const running = call('5');
        bumpAccountGeneration();
        slow.resolve(listed('old-account-photo'));
        await expect(running).resolves.toEqual({ success: false, error: 'account-changed' });
        // The same for a search: no account's photos reach a signed-out view.
        await expect(next('5', undefined, 'cached')).resolves.toMatchObject({ preview: false });
        expect(walk).toHaveBeenCalledTimes(2);
    });

    test('a read with no challenge to read through answers no-challenge-context even when the account left meanwhile: the context is judged first', async () => {
        const challenges = deferred<unknown>();
        const walk = newWalk();
        stubStrategy({
            getEligiblePhotosWalk: walk,
            getActiveChallenges: jest.fn<Promise<unknown>, [string]>(() => challenges.promise),
        });
        const running = call(undefined, null);
        bumpAccountGeneration();
        challenges.resolve({ challenges: [] });
        await expect(running).resolves.toEqual({ success: false, error: 'no-challenge-context' });
        expect(walk).not.toHaveBeenCalled();
    });

    test('any drop during a walk, whichever challenge it names, keeps that walk from writing', async () => {
        const slow = deferred<WalkResult>();
        const walk = newWalk(listed('b'));
        walk.mockReturnValueOnce(slow.promise);
        stubStrategy({ getEligiblePhotosWalk: walk });
        const running = call('5');
        dropContext('tok', '99');
        slow.resolve(listed('a'));
        await running;
        await next('5', undefined, 'cached');
        expect(walk).toHaveBeenCalledTimes(2);
    });

    test('a walk in flight when the challenge is dropped answers its photos but keeps nothing', async () => {
        const slow = deferred<WalkResult>();
        const walk = newWalk(listed('b'));
        walk.mockReturnValueOnce(slow.promise);
        stubStrategy({ getEligiblePhotosWalk: walk });
        const running = call('5');
        dropContext('tok', '5');
        slow.resolve(listed('a'));
        await expect(running).resolves.toMatchObject({ success: true });
        // Nothing was kept, so a cached request walks again.
        await expect(next('5', undefined, 'cached')).resolves.toMatchObject({ preview: false });
        expect(walk).toHaveBeenCalledTimes(2);
    });

    test.each([['stale'], [null], [7], [{}]])('refuses the mode %j before looking up the token', async (mode) => {
        const walk = newWalk();
        stubStrategy({ getEligiblePhotosWalk: walk });
        await expect(call('5', undefined, mode)).resolves.toEqual({ success: false, error: 'invalid-args' });
        expect(auth.requireAuthToken).not.toHaveBeenCalled();
        expect(walk).not.toHaveBeenCalled();
    });

    test('a cached answer reads the token once and signed out is the guard’s answer', async () => {
        auth.requireAuthToken = jest
            .fn()
            .mockReturnValue({ ok: false, response: { success: false, error: 'No token' } });
        stubStrategy();
        await expect(call('5', undefined, 'cached')).resolves.toEqual({ success: false, error: 'No token' });
    });

    test('a cached answer differs per account: another token is never shown this one’s listing', async () => {
        stubStrategy({ getEligiblePhotosWalk: newWalk(listed('a')) });
        await call('5');
        auth.requireAuthToken = jest.fn().mockReturnValue({ ok: true, token: 'other', settings: {} });
        const walk = newWalk(listed('b'));
        stubStrategy({ getEligiblePhotosWalk: walk });
        const result = await next('5', undefined, 'cached');
        expect(idsOf(result)).toEqual(['b']);
        expect(result).toMatchObject({ preview: false });
        expect(walk).toHaveBeenCalledTimes(1);
    });
});

describe('hasWonChallenge', () => {
    const photoWith = (permission: LibraryPhoto['permission']): LibraryPhoto =>
        invalid<LibraryPhoto>({ id: 'p', permission });

    test.each([
        "This image <b>has won a challenge</b><br/><span>it can't participate in another</span>",
        'THIS IMAGE HAS WON A CHALLENGE',
        'This image has <b>won</b> a challenge',
    ])('a photo the server says has won a challenge is one: %s', (message) => {
        expect(hasWonChallenge(photoWith({ allowed: false, message }))).toBe(true);
    });

    test.each([
        ['another blocked reason', { allowed: false, message: 'Already used in another challenge' }],
        ['a reason that only mentions winning', { allowed: false, message: 'Won a prize in the contest' }],
        ['an allowed photo, whatever it says', { allowed: true, message: 'has won a challenge' }],
        ['no message', { allowed: false, message: null }],
        ['no permission', undefined],
    ])('%s is not', (_name, permission) => {
        expect(hasWonChallenge(photoWith(permission))).toBe(false);
    });

    test('only the first 800 characters of the message are read', () => {
        const wording = 'has won a challenge';
        expect(hasWonChallenge(photoWith({ allowed: false, message: `${' '.repeat(781)}${wording}` }))).toBe(true);
        expect(hasWonChallenge(photoWith({ allowed: false, message: `${' '.repeat(790)}${wording}` }))).toBe(false);
    });
});
