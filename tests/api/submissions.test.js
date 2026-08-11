/**
 * Tests for submissions.js — getEligiblePhotos and submitToChallenge.
 */

const {
    getEligiblePhotos,
    getImageData,
    submitToChallenge,
    MAX_LIBRARY_PAGES,
} = require('../../src/js/api/submissions');

jest.mock('../../src/js/api/api-client', () => ({
    makePostRequest: jest.fn(),
    FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded; charset=utf-8',
}));

jest.mock('../../src/js/logger', () => {
    const level = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return { withCategory: jest.fn(() => level), __level: level };
});

describe('submissions', () => {
    const token = 'tok-123';
    const { makePostRequest } = require('../../src/js/api/api-client');

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
            expect(body).toBe('c_id=125319&limit=100&order=date&sort=desc&start=0&usage=submit');
            expect(photos).toEqual([{ id: 'p1', labels: ['Pink'], permission: { allowed: true } }]);
        });

        test('honours custom limit/start options', async () => {
            makePostRequest.mockResolvedValueOnce({ items: [] });
            await getEligiblePhotos('125319', token, { limit: 25, start: 50 });
            expect(makePostRequest.mock.calls[0][2]).toBe(
                'c_id=125319&limit=25&order=date&sort=desc&start=50&usage=submit',
            );
        });

        test('appends an encoded search param when a non-empty search is given', async () => {
            makePostRequest.mockResolvedValueOnce({ items: [] });
            await getEligiblePhotos('125319', token, { search: 'sun hat' });
            expect(makePostRequest.mock.calls[0][2]).toBe(
                'c_id=125319&limit=100&order=date&sort=desc&start=0&usage=submit&search=sun%20hat',
            );
        });

        test('omits the search param when search is empty/blank/non-string', async () => {
            makePostRequest.mockResolvedValue({ items: [] });
            const noSearch = 'c_id=1&limit=100&order=date&sort=desc&start=0&usage=submit';
            await getEligiblePhotos('1', token, { search: '' });
            expect(makePostRequest.mock.calls[0][2]).toBe(noSearch);
            await getEligiblePhotos('1', token, { search: '   ' });
            expect(makePostRequest.mock.calls[1][2]).toBe(noSearch);
            await getEligiblePhotos('1', token, { search: 123 });
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
            await expect(getEligiblePhotos('1', null)).rejects.toThrow(/token/);
        });
    });

    describe('getEligiblePhotos pagination', () => {
        const { __level: log } = require('../../src/js/logger');
        // limit=2 keeps the page arithmetic readable; a "short" page is <limit.
        const page = (...ids) => ({ items: ids.map((id) => ({ id })) });

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
            // Must NOT propagate: a transient failure on page 2 previously would
            // have been a single-request success, and throwing here would fail
            // the whole fill.
            expect(photos.map((p) => p.id)).toEqual(['p1', 'p2']);
            expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('page 2 failed'), null);
        });

        test('a mid-walk malformed page keeps what was fetched and warns', async () => {
            makePostRequest.mockResolvedValueOnce(page('p1', 'p2')).mockResolvedValueOnce({ nope: true });
            const photos = await getEligiblePhotos('c1', token, { limit: 2, paginate: true });
            expect(photos.map((p) => p.id)).toEqual(['p1', 'p2']);
            expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('no usable items'), null);
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
            expect(log.warning).toHaveBeenCalledWith(expect.stringContaining(`${MAX_LIBRARY_PAGES}-page cap`), null);
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
            await expect(submitToChallenge('1', null, token)).rejects.toThrow(/imageIds/);
            await expect(submitToChallenge('1', [], token)).rejects.toThrow(/imageIds/);
        });

        test('throws when challengeId or token missing', async () => {
            await expect(submitToChallenge('', ['p1'], token)).rejects.toThrow(/challengeId/);
            await expect(submitToChallenge('1', ['p1'], null)).rejects.toThrow(/token/);
        });
    });
});
