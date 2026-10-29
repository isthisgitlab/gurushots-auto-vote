/**
 * Tests for submissions.ts — getEligiblePhotos and submitToChallenge.
 */

import type * as submissionsModule from '../../src/ts/api/submissions';
import type * as api_clientModule from '../../src/ts/api/api-client';
import type { CategoryLogger } from '../../src/ts/logger';
import { LIBRARY_BATCH_PHOTOS, MAX_LIBRARY_KEEP_PHOTOS } from '../../src/ts/settings/limits';
import { invalid } from '../helpers/invalid';

const { getEligiblePhotos, getEligiblePhotosWalk, getImageData, submitToChallenge, MAX_LIBRARY_PAGES } =
    require('../../src/ts/api/submissions') as typeof submissionsModule;

jest.mock('../../src/ts/api/api-client', () => ({
    makePostRequest: jest.fn(),
    FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded; charset=utf-8',
}));

jest.mock('../../src/ts/logger', () => {
    const level = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return { withCategory: jest.fn(() => level), __level: level };
});

describe('submissions', () => {
    const token = 'tok-123';
    const { makePostRequest } = jest.mocked(require('../../src/ts/api/api-client') as typeof api_clientModule);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getEligiblePhotos', () => {
        test('builds a form-encoded body with the expected param order and uses web headers', async () => {
            makePostRequest.mockResolvedValueOnce({
                items: [{ id: 'p1', labels: ['Pink'], permission: { allowed: true } }],
            });
            const photos = await getEligiblePhotos('125319', token);
            expect(makePostRequest).toHaveBeenCalledTimes(1);
            const [url, headers, body] = makePostRequest.mock.calls[0];
            expect(url).toBe('https://api.gurushots.com/rest/get_photos_private');
            expect(headers).toEqual(
                expect.objectContaining({
                    'x-token': token,
                    'x-env': 'WEB',
                    'x-api-version': '13',
                    'x-requested-with': 'XMLHttpRequest',
                }),
            );
            expect(body).toBe('c_id=125319&limit=100&order=votes&sort=desc&start=0&usage=submit');
            expect(photos).toEqual([{ id: 'p1', labels: ['Pink'], permission: { allowed: true } }]);
        });

        test('honours custom limit/start options', async () => {
            makePostRequest.mockResolvedValueOnce({ items: [] });
            await getEligiblePhotos('125319', token, { limit: 25, start: 50 });
            expect(makePostRequest.mock.calls[0][2]).toBe(
                'c_id=125319&limit=25&order=votes&sort=desc&start=50&usage=submit',
            );
        });

        test('omits vote ordering when requesting the API default order', async () => {
            makePostRequest.mockResolvedValueOnce({ items: [] });
            await getEligiblePhotos('125319', token, { order: 'default' });
            expect(makePostRequest.mock.calls[0][2]).toBe('c_id=125319&limit=100&start=0&usage=submit');
        });

        test('appends an encoded search param when a non-empty search is given', async () => {
            makePostRequest.mockResolvedValueOnce({ items: [] });
            await getEligiblePhotos('125319', token, { search: 'sun hat' });
            expect(makePostRequest.mock.calls[0][2]).toBe(
                'c_id=125319&limit=100&order=votes&sort=desc&start=0&usage=submit&search=sun%20hat',
            );
        });

        test('omits the search param when search is empty/blank/non-string', async () => {
            makePostRequest.mockResolvedValue({ items: [] });
            const noSearch = 'c_id=1&limit=100&order=votes&sort=desc&start=0&usage=submit';
            await getEligiblePhotos('1', token, { search: '' });
            expect(makePostRequest.mock.calls[0][2]).toBe(noSearch);
            await getEligiblePhotos('1', token, { search: '   ' });
            expect(makePostRequest.mock.calls[1][2]).toBe(noSearch);
            await getEligiblePhotos('1', token, invalid({ search: 123 }));
            expect(makePostRequest.mock.calls[2][2]).toBe(noSearch);
        });

        test('returns [] when API returns null or no items', async () => {
            makePostRequest.mockResolvedValueOnce(null);
            expect(await getEligiblePhotos('1', token)).toEqual([]);
            makePostRequest.mockResolvedValueOnce({ items: 'not-an-array' });
            expect(await getEligiblePhotos('1', token)).toEqual([]);
        });

        test('throws when challengeId or token missing', async () => {
            await expect(getEligiblePhotos('', token)).rejects.toThrow(/challengeId/);
            await expect(getEligiblePhotos('1', invalid(null))).rejects.toThrow(/token/);
        });
    });

    describe('getEligiblePhotos pagination', () => {
        // The logger factory above also exports its shared level object.
        const {
            __level: log,
        }: {
            __level: {
                [K in 'info' | 'error' | 'debug' | 'success' | 'warning']: jest.MockedFunction<CategoryLogger[K]>;
            };
        } = invalid(require('../../src/ts/logger'));
        // limit=2 keeps the page arithmetic readable; a "short" page is <limit.
        const page = (...ids: string[]) => ({ items: ids.map((id) => ({ id })) });

        test('stays single-page by default — no paginate flag, no extra requests', async () => {
            makePostRequest.mockResolvedValueOnce(page('p1', 'p2'));
            const photos = await getEligiblePhotos('c1', token, { limit: 2 });
            expect(makePostRequest).toHaveBeenCalledTimes(1);
            expect(photos.map((p) => p.id)).toEqual(['p1', 'p2']);
        });

        test('walks pages until a short page and concatenates them', async () => {
            makePostRequest
                .mockResolvedValueOnce(page('p1', 'p2'))
                .mockResolvedValueOnce(page('p3', 'p4'))
                .mockResolvedValueOnce(page('p5'));
            const photos = await getEligiblePhotos('c1', token, { limit: 2, paginate: true });
            expect(makePostRequest).toHaveBeenCalledTimes(3);
            expect(photos.map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
            // start advances by limit each page.
            expect(makePostRequest.mock.calls[1][2]).toContain('start=2');
            expect(makePostRequest.mock.calls[2][2]).toContain('start=4');
        });

        test('dedupes ids repeated across pages', async () => {
            makePostRequest.mockResolvedValueOnce(page('p1', 'p2')).mockResolvedValueOnce(page('p2', 'p3'));
            const photos = await getEligiblePhotos('c1', token, { limit: 2, paginate: true });
            expect(photos.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
        });

        test('preserves the search term on every page', async () => {
            makePostRequest.mockResolvedValueOnce(page('p1', 'p2')).mockResolvedValueOnce(page('p3'));
            await getEligiblePhotos('c1', token, { limit: 2, paginate: true, search: 'hat' });
            expect(makePostRequest.mock.calls[0][2]).toContain('search=hat');
            expect(makePostRequest.mock.calls[1][2]).toContain('search=hat');
        });

        test('a mid-walk rejection keeps the pages already fetched and warns', async () => {
            makePostRequest.mockResolvedValueOnce(page('p1', 'p2')).mockRejectedValueOnce(new Error('socket hang up'));
            const photos = await getEligiblePhotos('c1', token, { limit: 2, paginate: true });
            // Must NOT propagate: the pages already fetched are usable, and
            // throwing here would fail the whole fill.
            expect(photos.map((p) => p.id)).toEqual(['p1', 'p2']);
            expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('reading page 2'), null);
        });

        test('a non-Error rejection is still reported by its value', async () => {
            makePostRequest.mockResolvedValueOnce(page('p1', 'p2')).mockRejectedValueOnce('ETIMEDOUT');
            const photos = await getEligiblePhotos('c1', token, { limit: 2, paginate: true });
            expect(photos.map((p) => p.id)).toEqual(['p1', 'p2']);
            expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('failed (ETIMEDOUT)'), null);
        });

        test('a mid-walk malformed page keeps what was fetched and warns', async () => {
            makePostRequest.mockResolvedValueOnce(page('p1', 'p2')).mockResolvedValueOnce({ nope: true });
            const photos = await getEligiblePhotos('c1', token, { limit: 2, paginate: true });
            expect(photos.map((p) => p.id)).toEqual(['p1', 'p2']);
            expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('came back empty or unreadable'), null);
        });

        test('a malformed FIRST page is just an empty library, not a warning', async () => {
            makePostRequest.mockResolvedValueOnce(null);
            const photos = await getEligiblePhotos('c1', token, { limit: 2, paginate: true });
            expect(photos).toEqual([]);
            expect(log.warning).not.toHaveBeenCalled();
        });

        test('stops at the page cap and says so rather than truncating silently', async () => {
            // Always a full page → the walk can only end at the cap.
            makePostRequest.mockResolvedValue(page('a', 'b'));
            const photos = await getEligiblePhotos('c1', token, { limit: 2, paginate: true });
            expect(makePostRequest).toHaveBeenCalledTimes(MAX_LIBRARY_PAGES);
            expect(photos.map((p) => p.id)).toEqual(['a', 'b']);
            expect(log.warning).toHaveBeenCalledWith(expect.stringContaining(`${MAX_LIBRARY_PAGES}-page limit`), null);
            // Default flow label is auto-fill.
            expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('autoSubmit:'), null);
        });

        test('the walk warning is prefixed with the caller flow (logLabel)', async () => {
            makePostRequest.mockResolvedValue(page('a', 'b'));
            await getEligiblePhotos('c1', token, { limit: 2, paginate: true, logLabel: 'join' });
            expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('join:'), null);
            expect(log.warning).not.toHaveBeenCalledWith(expect.stringContaining('autoSubmit:'), null);
        });

        test('abandons the walk when it outruns its wall-clock budget', async () => {
            // The walk is sequential and every page carries apiTimeout plus
            // retries, so a page cap alone cannot keep it inside the
            // emergency-fill window — the time budget is what does.
            const realNow = Date.now;
            let clock = 1_000_000;
            Date.now = () => clock;
            try {
                makePostRequest.mockImplementation(async () => {
                    clock += 5_000; // each page "takes" 5s
                    return page('a', 'b');
                });
                const photos = await getEligiblePhotos('c1', token, {
                    limit: 2,
                    paginate: true,
                    budgetMs: 12_000,
                });
                // Pages starting at t=0/5s/10s are allowed; the check at 15s stops it.
                expect(makePostRequest).toHaveBeenCalledTimes(3);
                expect(photos.map((p) => p.id)).toEqual(['a', 'b']);
                expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('took longer than'), null);
            } finally {
                Date.now = realNow;
            }
        });

        test('a non-positive limit cannot stall the walk on a single offset', async () => {
            // limit<=0 would break both the offset advance and the short-page
            // test, re-requesting start=0 until the page cap.
            makePostRequest.mockResolvedValueOnce({ items: [] });
            await getEligiblePhotos('c1', token, { limit: 0, paginate: true });
            expect(makePostRequest).toHaveBeenCalledTimes(1);
            expect(makePostRequest.mock.calls[0][2]).toContain('limit=100');
        });
    });

    describe('getEligiblePhotosWalk', () => {
        const page = (...ids: string[]) => ({ items: ids.map((id) => ({ id })) });
        const ids = (walk: { items: Array<{ id: string }> }) => walk.items.map((p) => p.id);

        test('walks to a short page without paginate and is not truncated', async () => {
            makePostRequest.mockResolvedValueOnce(page('p1', 'p2')).mockResolvedValueOnce(page('p3'));
            const walk = await getEligiblePhotosWalk('c1', token, { limit: 2, search: 'hat' });
            expect(ids(walk)).toEqual(['p1', 'p2', 'p3']);
            expect(walk.truncated).toBe(false);
            expect(makePostRequest.mock.calls[1][2]).toContain('search=hat');
        });

        test('an empty first page is a complete, empty library', async () => {
            makePostRequest.mockResolvedValueOnce(page());
            await expect(getEligiblePhotosWalk('c1', token, { limit: 2 })).resolves.toEqual({
                items: [],
                truncated: false,
                nextStart: 2,
                stop: 'end',
            });
        });

        test('every early stop is reported as truncated', async () => {
            // The page cap.
            makePostRequest.mockResolvedValue(page('a', 'b'));
            const capped = await getEligiblePhotosWalk('c1', token, { limit: 2 });
            expect(capped.truncated).toBe(true);
            expect(capped.stop).toBe('page-cap');
            // A failed page, the first included: not knowing is not "empty".
            makePostRequest.mockReset();
            makePostRequest.mockResolvedValueOnce(page('p1', 'p2')).mockRejectedValueOnce(new Error('down'));
            expect(await getEligiblePhotosWalk('c1', token, { limit: 2 })).toEqual({
                items: [{ id: 'p1' }, { id: 'p2' }],
                truncated: true,
                nextStart: 2,
                stop: 'failed',
            });
            makePostRequest.mockReset();
            makePostRequest.mockResolvedValueOnce(null);
            expect(await getEligiblePhotosWalk('c1', token, { limit: 2 })).toEqual({
                items: [],
                truncated: true,
                nextStart: 0,
                stop: 'failed',
            });
            // A later unreadable page.
            makePostRequest.mockReset();
            makePostRequest.mockResolvedValueOnce(page('p1', 'p2')).mockResolvedValueOnce({ nope: true });
            expect((await getEligiblePhotosWalk('c1', token, { limit: 2 })).truncated).toBe(true);
        });

        test('the wall-clock budget truncates it', async () => {
            const realNow = Date.now;
            let clock = 1_000_000;
            Date.now = () => clock;
            try {
                makePostRequest.mockImplementation(async () => {
                    clock += 5_000;
                    return page('a', 'b');
                });
                const walk = await getEligiblePhotosWalk('c1', token, { limit: 2, budgetMs: 12_000 });
                expect(walk.truncated).toBe(true);
                // Three pages fully read; the budget break re-reads from page 4's offset.
                expect(walk.nextStart).toBe(6);
                expect(makePostRequest).toHaveBeenCalledTimes(3);
            } finally {
                Date.now = realNow;
            }
        });

        test('passes over a photo with no id, with or without a skip', async () => {
            const withoutIds = { items: [{ id: 'p1' }, null, {}, { id: null }, { id: 'p2' }] };
            makePostRequest.mockResolvedValueOnce(invalid(withoutIds));
            expect(ids(await getEligiblePhotosWalk('c1', token, { limit: 10 }))).toEqual(['p1', 'p2']);
            makePostRequest.mockResolvedValueOnce(invalid(withoutIds));
            const walk = await getEligiblePhotosWalk('c1', token, { limit: 10, skip: () => false });
            expect(ids(walk)).toEqual(['p1', 'p2']);
            expect(walk.skipped).toEqual([]);
        });

        describe('with a skip predicate', () => {
            const isWinner = (photo: { id: string }) => photo.id.startsWith('w');
            const warnings = () => {
                const { __level: log }: { __level: { warning: jest.Mock<void, [string, unknown]> } } = invalid(
                    require('../../src/ts/logger'),
                );
                return log.warning.mock.calls.map((call) => call[0]);
            };

            test('leaves skipped photos out, reports their ids and keeps paging past them', async () => {
                makePostRequest
                    .mockResolvedValueOnce(page('w1', 'p1'))
                    .mockResolvedValueOnce(page('w2', 'w3'))
                    .mockResolvedValueOnce(page('p2'));
                const walk = await getEligiblePhotosWalk('c1', token, { limit: 2, skip: isWinner });
                expect(ids(walk)).toEqual(['p1', 'p2']);
                expect(walk.skipped).toEqual(['w1', 'w2', 'w3']);
                expect(walk.truncated).toBe(false);
                expect(makePostRequest).toHaveBeenCalledTimes(3);
            });

            test('does not read a skipped photo twice when a page overlaps', async () => {
                makePostRequest.mockResolvedValueOnce(page('w1', 'p1')).mockResolvedValueOnce(page('w1'));
                const walk = await getEligiblePhotosWalk('c1', token, { limit: 2, skip: isWinner });
                expect(ids(walk)).toEqual(['p1']);
                expect(walk.skipped).toEqual(['w1']);
            });

            test('stops once it has kept as many photos as the cap and says so', async () => {
                let next = 0;
                makePostRequest.mockImplementation(async () => page(`p${next++}`, `p${next++}`));
                const walk = await getEligiblePhotosWalk('c1', token, { limit: 2, skip: isWinner });
                expect(walk.items).toHaveLength(MAX_LIBRARY_PAGES * 2);
                expect(walk.truncated).toBe(true);
                expect(walk.skipped).toEqual([]);
                expect(makePostRequest).toHaveBeenCalledTimes(MAX_LIBRARY_PAGES);
                // The in-loop cap return sees the just-merged page.
                expect(walk.nextStart).toBe(MAX_LIBRARY_PAGES * 2);
                expect(warnings()).toContainEqual(
                    expect.stringContaining(`stopped reading your photo library at ${MAX_LIBRARY_PAGES * 2} photo(s)`),
                );
            });

            test('skipped photos do not use up the cap, up to twice the page limit', async () => {
                let next = 0;
                makePostRequest.mockImplementation(async () =>
                    page(`w${next++}`, `w${next++}`, `w${next++}`, `p${next++}`),
                );
                const walk = await getEligiblePhotosWalk('c1', token, { limit: 4, skip: isWinner });
                // One kept photo per page, far below the keep cap: only the 20-page ceiling ends the walk.
                expect(makePostRequest).toHaveBeenCalledTimes(2 * MAX_LIBRARY_PAGES);
                expect(walk.items).toHaveLength(2 * MAX_LIBRARY_PAGES);
                expect(walk.skipped).toHaveLength(6 * MAX_LIBRARY_PAGES);
                expect(walk.truncated).toBe(true);
                expect(walk.stop).toBe('page-cap');
                expect(warnings()).toContainEqual(expect.stringContaining(`${2 * MAX_LIBRARY_PAGES}-page limit`));
            });

            test('the wall-clock budget still ends it, with the skipped ids so far', async () => {
                const realNow = Date.now;
                let clock = 1_000_000;
                Date.now = () => clock;
                try {
                    makePostRequest.mockImplementation(async () => {
                        clock += 5_000;
                        return page('wa', 'pa');
                    });
                    const walk = await getEligiblePhotosWalk('c1', token, {
                        limit: 2,
                        budgetMs: 12_000,
                        skip: isWinner,
                    });
                    expect(makePostRequest).toHaveBeenCalledTimes(3);
                    expect(walk).toEqual({
                        items: [{ id: 'pa' }],
                        truncated: true,
                        skipped: ['wa'],
                        nextStart: 6,
                        stop: 'budget',
                    });
                } finally {
                    Date.now = realNow;
                }
            });

            test('a photo already kept is not also skipped, and one kept after being skipped leaves the skipped list', async () => {
                // `a` is read as kept and then as skipped; `b` the other way round.
                const answers: Record<string, boolean[]> = { a: [false, true], b: [true, false] };
                const reads: Record<string, number> = { a: 0, b: 0 };
                const skip = (photo: { id: string }) => answers[photo.id][reads[photo.id]++];
                makePostRequest
                    .mockResolvedValueOnce(page('a', 'b'))
                    .mockResolvedValueOnce(page('a', 'b'))
                    .mockResolvedValueOnce(page());
                const walk = await getEligiblePhotosWalk('c1', token, { limit: 2, skip });
                expect(ids(walk).sort()).toEqual(['a', 'b']);
                expect(walk.skipped).toEqual([]);
            });

            test('records no more skipped ids than the page ceiling could hold, even when pages carry more rows than asked', async () => {
                let next = 0;
                makePostRequest.mockImplementation(async () => page(...Array.from({ length: 5 }, () => `w${next++}`)));
                const walk = await getEligiblePhotosWalk('c1', token, { limit: 2, skip: isWinner });
                expect(makePostRequest).toHaveBeenCalledTimes(2 * MAX_LIBRARY_PAGES);
                expect(walk.skipped).toHaveLength(2 * MAX_LIBRARY_PAGES * 2);
                expect(walk.skipped?.[0]).toBe('w0');
                expect(walk.items).toEqual([]);
            });

            test('a mixed page that crosses the cap is kept whole, and the walk is truncated', async () => {
                let next = 0;
                const fresh = (n: number) => Array.from({ length: n }, () => `p${next++}`);
                makePostRequest.mockImplementation(async () => {
                    // Nine full pages of kept photos, then one with a winner among them that takes it past the cap.
                    return next < 9 * 4 ? page(...fresh(4)) : page(...fresh(2), 'wx', ...fresh(3));
                });
                const walk = await getEligiblePhotosWalk('c1', token, { limit: 4, skip: isWinner });
                expect(makePostRequest).toHaveBeenCalledTimes(MAX_LIBRARY_PAGES);
                expect(walk.items).toHaveLength(9 * 4 + 5);
                expect(walk.items.at(-1)?.id).toBe(`p${9 * 4 + 4}`);
                expect(walk.skipped).toEqual(['wx']);
                expect(walk.truncated).toBe(true);
            });

            test('a short last page that reaches the cap is still the end of the library', async () => {
                makePostRequest
                    .mockResolvedValueOnce(page(...Array.from({ length: 19 }, (_, i) => `p${i}`)))
                    .mockResolvedValueOnce(page('last'));
                const walk = await getEligiblePhotosWalk('c1', token, { limit: 2, skip: isWinner });
                expect(walk.items).toHaveLength(MAX_LIBRARY_PAGES * 2);
                expect(walk.truncated).toBe(false);
                expect(warnings()).toEqual([]);
            });

            test('without a skip the result has no skipped list and the cap is the page limit', async () => {
                makePostRequest.mockResolvedValue(page('a', 'b'));
                const walk = await getEligiblePhotosWalk('c1', token, { limit: 2 });
                expect(walk).not.toHaveProperty('skipped');
                expect(makePostRequest).toHaveBeenCalledTimes(MAX_LIBRARY_PAGES);
                expect(warnings()).toContainEqual(expect.stringContaining(`${MAX_LIBRARY_PAGES}-page limit`));
            });
        });

        describe('with maxKept and counts (batched walks)', () => {
            const warnings = () => {
                const { __level: log }: { __level: { warning: jest.Mock<void, [string, unknown]> } } = invalid(
                    require('../../src/ts/logger'),
                );
                return log.warning.mock.calls.map((call) => call[0]);
            };

            test('stops at the counted target; the page that crosses it is kept whole, with no warning', async () => {
                // One full page of 2 reaches maxKept: 2 — a single request.
                makePostRequest.mockResolvedValueOnce(page('p1', 'p2')).mockResolvedValueOnce(page('p3', 'p4'));
                const walk = await getEligiblePhotosWalk('c1', token, { limit: 2, maxKept: 2 });
                expect(makePostRequest).toHaveBeenCalledTimes(1);
                expect(ids(walk)).toEqual(['p1', 'p2']);
                expect(walk.truncated).toBe(true);
                expect(walk.stop).toBe('batch');
                expect(walk).not.toHaveProperty('skipped');
                expect(walk.nextStart).toBe(2);
                expect(warnings()).toEqual([]);
                // maxKept: 3 keeps the crossing second page whole.
                makePostRequest.mockReset();
                makePostRequest.mockResolvedValueOnce(page('p1', 'p2')).mockResolvedValueOnce(page('p3', 'p4'));
                const crossed = await getEligiblePhotosWalk('c1', token, { limit: 2, maxKept: 3 });
                expect(ids(crossed)).toEqual(['p1', 'p2', 'p3', 'p4']);
                expect(crossed.nextStart).toBe(4);
                expect(warnings()).toEqual([]);
            });

            test('maxKept is independent of skip: skipped photos do not count and the walk keeps paging', async () => {
                makePostRequest
                    .mockResolvedValueOnce(page('w1', 'p1'))
                    .mockResolvedValueOnce(page('w2', 'p2'))
                    .mockResolvedValueOnce(page('w3', 'p3'));
                const walk = await getEligiblePhotosWalk('c1', token, {
                    limit: 2,
                    maxKept: 3,
                    skip: (photo: { id: string }) => photo.id.startsWith('w'),
                });
                expect(makePostRequest).toHaveBeenCalledTimes(3);
                expect(ids(walk)).toEqual(['p1', 'p2', 'p3']);
                expect(walk.skipped).toEqual(['w1', 'w2', 'w3']);
                expect(walk.truncated).toBe(true);
                expect(walk.nextStart).toBe(6);
                expect(warnings()).toEqual([]);
            });

            test('with maxKept the walk reads past the kept-photo cap to reach a counted photo', async () => {
                // One full page of kept-but-uncounted photos past the keep cap of MAX_LIBRARY_PAGES * 2.
                const fullPages = MAX_LIBRARY_PAGES + 1;
                let next = 0;
                makePostRequest.mockImplementation(async () => {
                    if (next < fullPages * 2) return page(`p${next++}`, `p${next++}`);
                    return page('a1');
                });
                const walk = await getEligiblePhotosWalk('c1', token, {
                    limit: 2,
                    skip: (photo: { id: string }) => photo.id.startsWith('w'),
                    maxKept: 1,
                    counts: (photo: { id: string }) => photo.id.startsWith('a'),
                });
                expect(makePostRequest).toHaveBeenCalledTimes(fullPages + 1);
                expect(ids(walk)).toHaveLength(fullPages * 2 + 1);
                expect(ids(walk)).toContain('a1');
                expect(walk.stop).toBe('end');
                expect(walk.truncated).toBe(false);
                expect(walk.nextStart).toBe((fullPages + 1) * 2);
                expect(warnings()).toEqual([]);
            });

            test('with maxKept a walk that never reaches its count stops at the doubled page ceiling', async () => {
                let next = 0;
                makePostRequest.mockImplementation(async () => page(`p${next++}`, `p${next++}`));
                const walk = await getEligiblePhotosWalk('c1', token, {
                    limit: 2,
                    // Matches no photo here; a skip is what doubles the page ceiling.
                    skip: (photo: { id: string }) => photo.id.startsWith('w'),
                    maxKept: 1,
                    counts: () => false,
                });
                expect(makePostRequest).toHaveBeenCalledTimes(2 * MAX_LIBRARY_PAGES);
                expect(ids(walk)).toHaveLength(2 * MAX_LIBRARY_PAGES * 2);
                expect(walk.skipped).toEqual([]);
                expect(walk.stop).toBe('page-cap');
                expect(walk.truncated).toBe(true);
                expect(walk.nextStart).toBe(2 * MAX_LIBRARY_PAGES * 2);
                expect(warnings()).toContainEqual(expect.stringContaining(`${2 * MAX_LIBRARY_PAGES}-page limit`));
            });

            test('counts narrows which kept photos count toward maxKept; uncounted ones stay in items', async () => {
                // The walk stops after the crossing page, so only two pages are queued.
                makePostRequest.mockResolvedValueOnce(page('a1', 'a2')).mockResolvedValueOnce(page('a3', 'x1'));
                const walk = await getEligiblePhotosWalk('c1', token, {
                    limit: 2,
                    maxKept: 3,
                    counts: (photo: { id: string }) => !photo.id.startsWith('x'),
                });
                expect(makePostRequest).toHaveBeenCalledTimes(2);
                // x1 is kept but not counted: a1..a3 reached the target.
                expect(ids(walk)).toEqual(['a1', 'a2', 'a3', 'x1']);
                expect(walk.truncated).toBe(true);
                expect(walk.nextStart).toBe(4);
            });

            test('counts alone does not stop a walk', async () => {
                makePostRequest.mockResolvedValueOnce(page('p1', 'p2')).mockResolvedValueOnce(page('p3'));
                const walk = await getEligiblePhotosWalk('c1', token, { limit: 2, counts: () => false });
                expect(ids(walk)).toEqual(['p1', 'p2', 'p3']);
                expect(walk.truncated).toBe(false);
            });

            test('nextStart reports where each kind of exit left off', async () => {
                // Short page: start + (page + 1) * limit — past the one full page.
                makePostRequest.mockResolvedValueOnce(page('p1', 'p2')).mockResolvedValueOnce(page('p3'));
                expect((await getEligiblePhotosWalk('c1', token, { limit: 2 })).nextStart).toBe(4);
                // A failed page: start + page * limit — the page is re-read.
                makePostRequest.mockReset();
                makePostRequest.mockResolvedValueOnce(page('p1', 'p2')).mockRejectedValueOnce(new Error('down'));
                expect((await getEligiblePhotosWalk('c1', token, { limit: 2 })).nextStart).toBe(2);
                // An unreadable page: same.
                makePostRequest.mockReset();
                makePostRequest.mockResolvedValueOnce(page('p1', 'p2')).mockResolvedValueOnce({ nope: true });
                expect((await getEligiblePhotosWalk('c1', token, { limit: 2 })).nextStart).toBe(2);
                // An unreadable FIRST page: start itself.
                makePostRequest.mockReset();
                makePostRequest.mockResolvedValueOnce(null);
                expect((await getEligiblePhotosWalk('c1', token, { limit: 2 })).nextStart).toBe(0);
                // The page cap: start + maxPages * limit.
                makePostRequest.mockReset();
                makePostRequest.mockResolvedValue(page('a', 'b'));
                expect((await getEligiblePhotosWalk('c1', token, { limit: 2 })).nextStart).toBe(MAX_LIBRARY_PAGES * 2);
                // With a skip the page ceiling is doubled.
                makePostRequest.mockReset();
                makePostRequest.mockResolvedValue(page('a', 'b'));
                expect((await getEligiblePhotosWalk('c1', token, { limit: 2, skip: () => true })).nextStart).toBe(
                    2 * MAX_LIBRARY_PAGES * 2,
                );
                // And a non-zero start is where the arithmetic begins.
                makePostRequest.mockReset();
                makePostRequest.mockResolvedValueOnce(page('p1', 'p2')).mockResolvedValueOnce(page('p3'));
                expect((await getEligiblePhotosWalk('c1', token, { limit: 2, start: 4 })).nextStart).toBe(8);
            });
        });

        test('still refuses a missing challenge id or token', async () => {
            await expect(getEligiblePhotosWalk('', token)).rejects.toThrow();
            await expect(getEligiblePhotosWalk('c1', '')).rejects.toThrow();
        });
    });

    describe('getImageData', () => {
        test('posts the id and returns the photo record', async () => {
            makePostRequest.mockResolvedValueOnce({ success: true, data: { id: 'img1', votes: 3701, views: 1203 } });
            const photo = await getImageData('img1', token);
            const [url, headers, body] = makePostRequest.mock.calls[0];
            expect(url).toBe('https://api.gurushots.com/rest/get_image_data');
            expect(headers).toEqual(expect.objectContaining({ 'x-token': token, 'x-env': 'WEB' }));
            expect(body).toBe('id=img1');
            expect(photo).toEqual({ id: 'img1', votes: 3701, views: 1203 });
        });

        test('url-encodes the id', async () => {
            makePostRequest.mockResolvedValueOnce({ success: true, data: { id: 'a b&c' } });
            await getImageData('a b&c', token);
            expect(makePostRequest.mock.calls[0][2]).toBe('id=a%20b%26c');
        });

        test('returns null when the payload is unsuccessful', async () => {
            makePostRequest.mockResolvedValueOnce({ success: false, data: { id: 'img1' } });
            expect(await getImageData('img1', token)).toBeNull();
        });

        test('returns null on a null response', async () => {
            makePostRequest.mockResolvedValueOnce(null);
            expect(await getImageData('img1', token)).toBeNull();
        });

        test('returns null when data is missing or not an object', async () => {
            makePostRequest.mockResolvedValueOnce({ success: true });
            expect(await getImageData('img1', token)).toBeNull();
            makePostRequest.mockResolvedValueOnce({ success: true, data: ['nope'] });
            expect(await getImageData('img1', token)).toBeNull();
        });

        test('requires an id and a token', async () => {
            await expect(getImageData('', token)).rejects.toThrow('submissions: imageId is required');
            await expect(getImageData('img1', '')).rejects.toThrow('submissions: token is required');
        });
    });

    describe('submitToChallenge', () => {
        test('builds form-encoded body with image_ids[i] for one photo', async () => {
            makePostRequest.mockResolvedValueOnce({ success: true, challenge_id: 125319, member_challenge_count: 5 });
            const result = await submitToChallenge('125319', ['c7f3cd9e94cd0b474edee1c77b8b746f'], token);
            expect(makePostRequest).toHaveBeenCalledTimes(1);
            const [url, headers, body] = makePostRequest.mock.calls[0];
            expect(url).toBe('https://api.gurushots.com/rest/submit_to_challenge');
            expect(headers['x-env']).toBe('WEB');
            expect(headers['x-token']).toBe(token);
            expect(body).toBe('c_id=125319&el=challenges&el_id=true&image_ids[0]=c7f3cd9e94cd0b474edee1c77b8b746f');
            expect(result).toEqual({ ok: true, raw: expect.objectContaining({ success: true }) });
        });

        test('builds form-encoded body with multiple image_ids', async () => {
            makePostRequest.mockResolvedValueOnce({ success: true });
            await submitToChallenge('125319', ['a', 'b', 'c'], token);
            expect(makePostRequest.mock.calls[0][2]).toBe(
                'c_id=125319&el=challenges&el_id=true&image_ids[0]=a&image_ids[1]=b&image_ids[2]=c',
            );
        });

        test('url-encodes image ids', async () => {
            makePostRequest.mockResolvedValueOnce({ success: true });
            await submitToChallenge('1', ['a/b c'], token);
            const body = makePostRequest.mock.calls[0][2];
            expect(body).toContain('image_ids[0]=a%2Fb%20c');
        });

        test('returns ok=false when API returns null', async () => {
            makePostRequest.mockResolvedValueOnce(null);
            const result = await submitToChallenge('1', ['p1'], token);
            expect(result).toEqual({ ok: false, raw: null });
        });

        test('returns ok=false when success is not true', async () => {
            makePostRequest.mockResolvedValueOnce({ success: false, error: 'denied' });
            const result = await submitToChallenge('1', ['p1'], token);
            expect(result.ok).toBe(false);
            expect(result.raw).toEqual({ success: false, error: 'denied' });
        });

        test('throws when imageIds is not an array or is empty', async () => {
            await expect(submitToChallenge('1', invalid(null), token)).rejects.toThrow(/imageIds/);
            await expect(submitToChallenge('1', [], token)).rejects.toThrow(/imageIds/);
        });

        test('throws when challengeId or token missing', async () => {
            await expect(submitToChallenge('', ['p1'], token)).rejects.toThrow(/challengeId/);
            await expect(submitToChallenge('1', ['p1'], invalid(null))).rejects.toThrow(/token/);
        });
    });
});

describe('getEligiblePhotos usage option', () => {
    const token = 'tok-123';
    const { makePostRequest } = jest.mocked(require('../../src/ts/api/api-client') as typeof api_clientModule);

    beforeEach(() => jest.clearAllMocks());

    test("defaults to usage=submit and ignores anything but 'swap'", async () => {
        makePostRequest.mockResolvedValue({ items: [] });
        await getEligiblePhotos(1, token, { usage: 'evil&x=1' });
        expect(makePostRequest.mock.calls[0][2]).toBe('c_id=1&limit=100&order=votes&sort=desc&start=0&usage=submit');
    });

    test('usage=swap on a single page', async () => {
        makePostRequest.mockResolvedValue({ items: [] });
        await getEligiblePhotos(1, token, { usage: 'swap' });
        expect(makePostRequest.mock.calls[0][2]).toBe('c_id=1&limit=100&order=votes&sort=desc&start=0&usage=swap');
    });

    test('usage=swap is sent on every page of a paginated walk', async () => {
        const page = (start: number) => Array.from({ length: 2 }, (_, i) => ({ id: `p${start + i}` }));
        makePostRequest
            .mockResolvedValueOnce({ items: page(0) })
            .mockResolvedValueOnce({ items: page(2) })
            .mockResolvedValueOnce({ items: [] });
        await getEligiblePhotos(1, token, { usage: 'swap', paginate: true, limit: 2 });
        expect(makePostRequest).toHaveBeenCalledTimes(3);
        for (const [, , body] of makePostRequest.mock.calls) {
            expect(body).toContain('usage=swap');
        }
    });
});

describe('getEligiblePhotos order mapping (librarySort)', () => {
    const token = 'tok-123';
    const { makePostRequest } = jest.mocked(require('../../src/ts/api/api-client') as typeof api_clientModule);

    beforeEach(() => jest.clearAllMocks());

    test.each([
        ['votes', 'order=votes&sort=desc'],
        ['newest', 'order=date&sort=desc'],
        ['oldest', 'order=date&sort=asc'],
    ])('%s is mapped to the fixed literals %s', async (order, wire) => {
        makePostRequest.mockResolvedValueOnce({ items: [] });
        await getEligiblePhotos('1', token, { order: invalid(order) });
        expect(makePostRequest.mock.calls[0][2]).toBe(`c_id=1&limit=100&${wire}&start=0&usage=submit`);
    });

    test('a paginated walk carries its order on every page, continuations included', async () => {
        const page = (start: number) => ({ items: Array.from({ length: 2 }, (_, i) => ({ id: `p${start + i}` })) });
        makePostRequest
            .mockResolvedValueOnce(page(0))
            .mockResolvedValueOnce(page(2))
            .mockResolvedValueOnce({ items: [] });
        await getEligiblePhotos('1', token, { order: 'oldest', paginate: true, limit: 2 });
        expect(makePostRequest).toHaveBeenCalledTimes(3);
        for (const [, , body] of makePostRequest.mock.calls) {
            expect(body).toContain('order=date&sort=asc');
        }
        // The walk's cross-page id dedupe is unchanged by the order.
        expect(makePostRequest.mock.calls[1][2]).toContain('start=2');
    });
});

describe('getEligiblePhotos readState: a failed first page is told apart from an empty library', () => {
    const token = 'tok-123';
    const { makePostRequest } = jest.mocked(require('../../src/ts/api/api-client') as typeof api_clientModule);
    const state = () => ({ firstPageFailed: false });

    beforeEach(() => jest.clearAllMocks());

    test('one page: a failed request or a payload with no list sets it, an empty list does not', async () => {
        for (const [answer, failed] of [
            [null, true],
            [{ nope: true }, true],
            [{ items: [] }, false],
        ] as const) {
            makePostRequest.mockResolvedValueOnce(answer);
            const readState = state();
            expect(await getEligiblePhotos('1', token, { readState })).toEqual([]);
            expect(readState.firstPageFailed).toBe(failed);
        }
    });

    test('a walk: a failed or unreadable first page sets it, and so does one that throws', async () => {
        for (const first of [null, { nope: true }]) {
            makePostRequest.mockResolvedValueOnce(first);
            const readState = state();
            expect(await getEligiblePhotos('1', token, { paginate: true, readState })).toEqual([]);
            expect(readState.firstPageFailed).toBe(true);
        }
        makePostRequest.mockRejectedValueOnce(new Error('boom'));
        const thrown = state();
        expect(await getEligiblePhotos('1', token, { paginate: true, readState: thrown })).toEqual([]);
        expect(thrown.firstPageFailed).toBe(true);
    });

    test('a walk that read its first page and failed on a later one is a partial read, not a failed one', async () => {
        makePostRequest.mockResolvedValueOnce({ items: [{ id: 'a' }, { id: 'b' }] }).mockResolvedValueOnce(null);
        const readState = state();
        const photos = await getEligiblePhotos('1', token, { paginate: true, limit: 2, readState });
        expect(photos).toHaveLength(2);
        expect(readState.firstPageFailed).toBe(false);
        makePostRequest
            .mockResolvedValueOnce({ items: [{ id: 'a' }, { id: 'b' }] })
            .mockRejectedValueOnce(new Error('x'));
        const thrown = state();
        await getEligiblePhotos('1', token, { paginate: true, limit: 2, readState: thrown });
        expect(thrown.firstPageFailed).toBe(false);
    });

    test('without a readState nothing changes', async () => {
        makePostRequest.mockResolvedValueOnce(null);
        expect(await getEligiblePhotos('1', token)).toEqual([]);
        makePostRequest.mockResolvedValueOnce(null);
        expect(await getEligiblePhotos('1', token, { paginate: true })).toEqual([]);
    });
});

describe('library limits', () => {
    test('the keep cap is the walk page cap times the default page, so the two cannot drift', () => {
        expect(MAX_LIBRARY_KEEP_PHOTOS).toBe(MAX_LIBRARY_PAGES * LIBRARY_BATCH_PHOTOS);
    });
});
