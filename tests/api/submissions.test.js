/**
 * Tests for submissions.js — getEligiblePhotos and submitToChallenge.
 */

const { getEligiblePhotos, submitToChallenge } = require('../../src/js/api/submissions');

jest.mock('../../src/js/api/api-client', () => ({
    makePostRequest: jest.fn(),
    FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded; charset=utf-8',
}));

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
