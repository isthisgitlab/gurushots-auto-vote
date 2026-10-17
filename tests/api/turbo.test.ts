/**
 * Tests for turbo.ts
 */

import type * as turboModule from '../../src/ts/api/turbo';
import type * as api_clientModule from '../../src/ts/api/api-client';

const { getChallengeTurbo, submitTurboSelection, applyTurbo, startTurboSession, submitSnapVote } =
    require('../../src/ts/api/turbo') as typeof turboModule;

jest.mock('../../src/ts/api/api-client', () => ({
    makePostRequest: jest.fn(),
    postOnce: jest.fn(),
    FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded; charset=utf-8',
}));

describe('turbo', () => {
    const mockToken = 'test-token-123';
    const { makePostRequest, postOnce } = jest.mocked(
        require('../../src/ts/api/api-client') as typeof api_clientModule,
    );

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

    describe('startTurboSession', () => {
        const hex = (seed: string) => seed.repeat(32).slice(0, 32);
        const IMG = { image_id: hex('a'), member_id: hex('b'), width: 1024, height: 1024 };
        const IMG2 = { image_id: hex('c'), member_id: hex('d') };
        const snap = {
            success: true,
            session_type: '2.0',
            session_id: 'sess-1',
            position: 1,
            caption: 'Does the soft, even light look natural?',
            sub_caption: null,
            images: [IMG, IMG2],
        };

        test('posts the challenge id and normalizes a Snap session', async () => {
            makePostRequest.mockResolvedValueOnce(snap);

            const result = await startTurboSession('124113', mockToken);

            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest/start_turbo_session',
                expect.objectContaining({ 'x-token': mockToken, 'x-env': 'WEB', 'x-api-version': '13' }),
                'challenge_id=124113',
            );
            expect(result).toEqual({
                kind: 'snap',
                sessionId: 'sess-1',
                position: 1,
                caption: 'Does the soft, even light look natural?',
                images: [
                    { imageId: hex('a'), memberId: hex('b') },
                    { imageId: hex('c'), memberId: hex('d') },
                ],
            });
        });

        test('session_type 1.0 is the classic game', async () => {
            makePostRequest.mockResolvedValueOnce({ session_type: '1.0', success: true });
            expect(await startTurboSession(1, mockToken)).toEqual({ kind: 'classic' });
        });

        test('null for a failed request, success other than true, or an unknown session_type', async () => {
            makePostRequest.mockResolvedValueOnce(null);
            expect(await startTurboSession(1, mockToken)).toBeNull();
            makePostRequest.mockResolvedValueOnce({ ...snap, success: false });
            expect(await startTurboSession(1, mockToken)).toBeNull();
            makePostRequest.mockResolvedValueOnce({ ...snap, session_type: '3.0' });
            expect(await startTurboSession(1, mockToken)).toBeNull();
        });

        test('null for a malformed Snap body', async () => {
            makePostRequest.mockResolvedValueOnce({ ...snap, session_id: 7 });
            expect(await startTurboSession(1, mockToken)).toBeNull();
            makePostRequest.mockResolvedValueOnce({ ...snap, session_id: '' });
            expect(await startTurboSession(1, mockToken)).toBeNull();
            makePostRequest.mockResolvedValueOnce({ ...snap, images: undefined });
            expect(await startTurboSession(1, mockToken)).toBeNull();
            makePostRequest.mockResolvedValueOnce({ ...snap, caption: null });
            expect(await startTurboSession(1, mockToken)).toBeNull();
        });

        test('null when the position is not an integer from 0 to the image count', async () => {
            for (const position of [-1, 3, 1.5, '1', null, undefined]) {
                makePostRequest.mockResolvedValueOnce({ ...snap, position });
                expect(await startTurboSession(1, mockToken)).toBeNull();
            }
            for (const position of [0, 2]) {
                makePostRequest.mockResolvedValueOnce({ ...snap, position });
                expect(await startTurboSession(1, mockToken)).toEqual(expect.objectContaining({ position }));
            }
        });

        test('null when the list is empty or any image is malformed, so the position never shifts', async () => {
            const malformed = [
                null,
                'i9',
                7,
                [],
                { image_id: '', member_id: hex('b') },
                { image_id: hex('a'), member_id: '' },
                { image_id: 5, member_id: hex('b') },
                { image_id: 'i1', member_id: 'm1' },
                { image_id: hex('a') },
            ];
            makePostRequest.mockResolvedValueOnce({ ...snap, images: [], position: 0 });
            expect(await startTurboSession(1, mockToken)).toBeNull();
            for (const bad of malformed) {
                makePostRequest.mockResolvedValueOnce({ ...snap, images: [IMG, bad] });
                expect(await startTurboSession(1, mockToken)).toBeNull();
            }
        });

        test('requires a challenge id and a token', async () => {
            await expect(startTurboSession('', mockToken)).rejects.toThrow('turbo: challengeId is required');
            await expect(startTurboSession(1, '')).rejects.toThrow('turbo: token is required');
        });
    });

    describe('submitSnapVote', () => {
        test('posts the answer once and maps a counted vote', async () => {
            postOnce.mockResolvedValueOnce({ kind: 'body', body: { community_pct: 67, success: true } });

            const result = await submitSnapVote('sess-1', 'i1', 'yes', mockToken);

            expect(postOnce).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest/submit_snap_vote',
                expect.objectContaining({ 'x-token': mockToken, 'x-env': 'WEB' }),
                'session_id=sess-1&image_id=i1&vote=yes',
            );
            expect(makePostRequest).not.toHaveBeenCalled();
            expect(result).toEqual({ ok: true, completed: false, communityPct: 67, errorCode: null, unclear: false });
        });

        test('the last answer reports completed', async () => {
            postOnce.mockResolvedValueOnce({
                kind: 'body',
                body: { community_pct: 40, success: true, completed: true },
            });
            expect(await submitSnapVote('s', 'i', 'no', mockToken)).toEqual({
                ok: true,
                completed: true,
                communityPct: 40,
                errorCode: null,
                unclear: false,
            });
        });

        test('a dead session carries its error code', async () => {
            postOnce.mockResolvedValueOnce({
                kind: 'body',
                body: { success: false, error_code: 1105, message: 'Turbo is not available, please try again' },
            });
            expect(await submitSnapVote('s', 'i', 'no', mockToken)).toEqual({
                ok: false,
                completed: false,
                communityPct: null,
                errorCode: 1105,
                unclear: false,
            });
        });

        test('a refusal is not ok and not unclear; an unclear answer is flagged', async () => {
            postOnce.mockResolvedValueOnce({ kind: 'refused' });
            expect(await submitSnapVote('s', 'i', 'yes', mockToken)).toEqual({
                ok: false,
                completed: false,
                communityPct: null,
                errorCode: null,
                unclear: false,
            });
            postOnce.mockResolvedValueOnce({ kind: 'unclear' });
            expect(await submitSnapVote('s', 'i', 'yes', mockToken)).toEqual({
                ok: false,
                completed: false,
                communityPct: null,
                errorCode: null,
                unclear: true,
            });
        });

        test('requires a session id, an image id and a token', async () => {
            await expect(submitSnapVote('', 'i', 'yes', mockToken)).rejects.toThrow('turbo: sessionId is required');
            await expect(submitSnapVote('s', '', 'yes', mockToken)).rejects.toThrow('turbo: imageId is required');
            await expect(submitSnapVote('s', 'i', 'yes', '')).rejects.toThrow('turbo: token is required');
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
