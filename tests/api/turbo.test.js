/**
 * Tests for turbo.js
 */

const { getChallengeTurbo, submitTurboSelection, applyTurbo } = require('../../src/js/api/turbo');

jest.mock('../../src/js/api/api-client', () => ({
    makePostRequest: jest.fn(),
    FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded; charset=utf-8',
}));

describe('turbo', () => {
    const mockToken = 'test-token-123';
    const { makePostRequest } = require('../../src/js/api/api-client');

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getChallengeTurbo', () => {
        test('parses a successful battle set into normalized shape', async () => {
            makePostRequest.mockResolvedValueOnce({
                turbo_unlock_type: 'COINS',
                max_selections: 10,
                required_selections: 6,
                images: [
                    { is_success: null, first_image: { id: 'a1' }, second_image: { id: 'a2' } },
                    { is_success: null, first_image: { id: 'b1' }, second_image: { id: 'b2' } },
                ],
            });

            const result = await getChallengeTurbo('124113', mockToken);

            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest/get_challenge_turbo',
                expect.objectContaining({ 'x-token': mockToken, 'x-env': 'WEB', 'x-api-version': '13' }),
                'challenge_id=124113',
            );
            expect(result).toEqual({
                battles: [
                    { firstImageId: 'a1', secondImageId: 'a2', isSuccess: null },
                    { firstImageId: 'b1', secondImageId: 'b2', isSuccess: null },
                ],
                maxSelections: 10,
                requiredSelections: 6,
            });
        });

        test('returns null when response is empty', async () => {
            makePostRequest.mockResolvedValueOnce(null);
            const result = await getChallengeTurbo('124113', mockToken);
            expect(result).toBeNull();
        });

        test('returns null when images array is missing', async () => {
            makePostRequest.mockResolvedValueOnce({ success: false, error_code: 1105 });
            const result = await getChallengeTurbo('124113', mockToken);
            expect(result).toBeNull();
        });
    });

    describe('submitTurboSelection', () => {
        test('returns ok=true when the pick was correct', async () => {
            makePostRequest.mockResolvedValueOnce({
                is_successful_selection: true,
                state: 'IN_PROGRESS',
                scores: { first_image: 70, second_image: 30 },
                success: true,
            });

            const result = await submitTurboSelection('124113', 'a1', mockToken);

            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest/submit_challenge_turbo_selection',
                expect.objectContaining({ 'x-token': mockToken }),
                'challenge_id=124113&image_id=a1',
            );
            expect(result.ok).toBe(true);
            expect(result.state).toBe('IN_PROGRESS');
            expect(result.scores).toEqual({ first_image: 70, second_image: 30 });
        });

        test('returns ok=false when the pick was wrong', async () => {
            makePostRequest.mockResolvedValueOnce({
                is_successful_selection: false,
                state: 'IN_PROGRESS',
                scores: { first_image: 23, second_image: 77 },
                success: true,
            });

            const result = await submitTurboSelection('124113', 'a1', mockToken);

            expect(result.ok).toBe(false);
            expect(result.success).toBe(true);
        });

        test('surfaces error_code when the API returns success=false', async () => {
            makePostRequest.mockResolvedValueOnce({
                success: false,
                error_code: 1105,
                message: 'Turbo is not available, please try again',
            });

            const result = await submitTurboSelection('124113', 'a1', mockToken);

            expect(result.ok).toBe(false);
            expect(result.success).toBe(false);
            expect(result.errorCode).toBe(1105);
        });

        test('returns ok=false when the request fails outright', async () => {
            makePostRequest.mockResolvedValueOnce(null);
            const result = await submitTurboSelection('124113', 'a1', mockToken);
            expect(result.ok).toBe(false);
            expect(result.raw).toBeNull();
        });

        test('reports a WON state when the threshold is hit', async () => {
            makePostRequest.mockResolvedValueOnce({
                is_successful_selection: true,
                state: 'WON',
                scores: { first_image: 59, second_image: 41 },
                success: true,
            });

            const result = await submitTurboSelection('124113', 'a1', mockToken);
            expect(result.state).toBe('WON');
            expect(result.ok).toBe(true);
        });
    });

    describe('applyTurbo', () => {
        test('posts the entry image id and returns ok=true on success', async () => {
            makePostRequest.mockResolvedValueOnce({ success: true });

            const result = await applyTurbo('125305', 'entry-1', mockToken);

            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest/set_challenge_turbo',
                expect.objectContaining({ 'x-token': mockToken }),
                'challenge_id=125305&image_id=entry-1',
            );
            expect(result).toEqual({ ok: true, raw: { success: true } });
        });

        test('returns ok=false when the request fails', async () => {
            makePostRequest.mockResolvedValueOnce(null);
            const result = await applyTurbo('125305', 'entry-1', mockToken);
            expect(result).toEqual({ ok: false, raw: null });
        });

        test('returns ok=false when API responds with success=false', async () => {
            makePostRequest.mockResolvedValueOnce({ success: false, error_code: 1106 });
            const result = await applyTurbo('125305', 'entry-1', mockToken);
            expect(result.ok).toBe(false);
            expect(result.raw).toEqual({ success: false, error_code: 1106 });
        });
    });
});
