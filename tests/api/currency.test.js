/**
 * Tests for api/currency.js — keyUnlock, swapPhoto, exposureAutofill.
 * Focus: exact endpoint + WEB headers, form-body encoding of every dynamic
 * value (no field injection), and the {ok, raw} result contract.
 */

const { keyUnlock, swapPhoto, exposureAutofill } = require('../../src/js/api/currency');

jest.mock('../../src/js/api/api-client', () => ({
    makePostRequest: jest.fn(),
    FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded; charset=utf-8',
}));

const { makePostRequest } = require('../../src/js/api/api-client');
const token = 'tok-123';

beforeEach(() => jest.clearAllMocks());

const lastCall = () => {
    const [url, headers, body] = makePostRequest.mock.calls[0];
    return { url, headers, body };
};

describe('keyUnlock', () => {
    test('posts c_id + EXPOSURE_BOOST usage with WEB headers', async () => {
        makePostRequest.mockResolvedValueOnce({ success: true });
        const result = await keyUnlock(133849, token);
        const { url, headers, body } = lastCall();
        expect(url).toBe('https://api.gurushots.com/rest/key_unlock');
        expect(headers).toEqual(expect.objectContaining({ 'x-env': 'WEB', 'x-token': token }));
        expect(body).toBe('c_id=133849&usage=EXPOSURE_BOOST');
        expect(result).toEqual({ ok: true, raw: { success: true } });
    });

    test('encodes the challenge id (no form-field injection)', async () => {
        makePostRequest.mockResolvedValueOnce({ success: true });
        await keyUnlock('1&usage=OTHER', token);
        expect(lastCall().body).toBe('c_id=1%26usage%3DOTHER&usage=EXPOSURE_BOOST');
    });

    test('requires challengeId and token', async () => {
        await expect(keyUnlock('', token)).rejects.toThrow('currency: challengeId is required');
        await expect(keyUnlock(1, '')).rejects.toThrow('currency: token is required');
        expect(makePostRequest).not.toHaveBeenCalled();
    });
});

describe('swapPhoto', () => {
    test('posts the recorded swap body', async () => {
        makePostRequest.mockResolvedValueOnce({ first_time: true, success: true });
        const result = await swapPhoto(134775, 'old1', 'new2', token);
        const { url, body } = lastCall();
        expect(url).toBe('https://api.gurushots.com/rest/swap');
        expect(body).toBe('c_id=134775&el=challenges&el_id=true&img_id=old1&new_img_id=new2');
        expect(result.ok).toBe(true);
    });

    test('encodes image ids', async () => {
        makePostRequest.mockResolvedValueOnce({ success: true });
        await swapPhoto(1, 'a&b', 'c=d', token);
        expect(lastCall().body).toBe('c_id=1&el=challenges&el_id=true&img_id=a%26b&new_img_id=c%3Dd');
    });

    test('requires both image ids', async () => {
        await expect(swapPhoto(1, '', 'n', token)).rejects.toThrow('oldImageId is required');
        await expect(swapPhoto(1, 'o', null, token)).rejects.toThrow('newImageId is required');
    });
});

describe('exposureAutofill', () => {
    test('posts challenge_ids[0] + member id', async () => {
        makePostRequest.mockResolvedValueOnce({ success: true });
        await exposureAutofill(134808, 'member-abc', token);
        const { url, body } = lastCall();
        expect(url).toBe('https://api.gurushots.com/rest/exposure_autofill');
        expect(body).toBe('challenge_ids%5B0%5D=134808&el=my_challenges&el_id=member-abc');
    });
});

describe('result contract', () => {
    test('null transport result → ok:false, raw:null', async () => {
        makePostRequest.mockResolvedValueOnce(null);
        expect(await keyUnlock(1, token)).toEqual({ ok: false, raw: null });
    });

    test('success:false → ok:false with the raw body', async () => {
        makePostRequest.mockResolvedValueOnce({ success: false, message: 'nope' });
        expect(await exposureAutofill(1, 'm', token)).toEqual({ ok: false, raw: { success: false, message: 'nope' } });
    });
});
