/**
 * Simplified tests for voting.js
 *
 * Tests the vote images fetching and submission functionality.
 */

const { getVoteImages, submitVotes } = require('../../src/js/api/voting');

// Mock the makePostRequest function
jest.mock('../../src/js/api/api-client', () => ({
    makePostRequest: jest.fn(),
    FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded',
    createCommonHeaders: jest.fn(() => ({ 'x-token': 'test-token' })),
}));

// Create shared mock functions to track calls across categories
const mockInfoFn = jest.fn();
const mockWarningFn = jest.fn();
const mockDebugFn = jest.fn();
const mockErrorFn = jest.fn();

// Mock the logger module
jest.mock('../../src/js/logger', () => {
    const mockEndOperationFn = jest.fn();

    return {
        info: jest.fn(),
        warning: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        startOperation: jest.fn(() => 'mock-operation-id'),
        endOperation: jest.fn(),
        withCategory: jest.fn(() => ({
            info: mockInfoFn,
            warning: mockWarningFn,
            debug: mockDebugFn,
            error: mockErrorFn,
            api: jest.fn(),
            apiRequest: jest.fn(),
            startOperation: jest.fn(),
            endOperation: mockEndOperationFn,
            progress: jest.fn(),
            success: jest.fn(),
        })),
        challengeTag: (c, t) =>
            c && typeof c === 'object'
                ? `[Challenge ${c.id ?? 'unknown'}: ${c.title ?? 'unknown'}]`
                : `[Challenge ${c ?? 'unknown'}: ${t ?? 'unknown'}]`,
        // Export the mock functions for testing
        __mockEndOperationFn: mockEndOperationFn,
    };
});

// Mock the metadata module
jest.mock('../../src/js/metadata', () => ({
    updateChallengeVoteMetadata: jest.fn(() => true),
}));

const { makePostRequest } = require('../../src/js/api/api-client');
const logger = require('../../src/js/logger');
const { updateChallengeVoteMetadata } = require('../../src/js/metadata');

describe('voting', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockInfoFn.mockClear();
        mockWarningFn.mockClear();
        mockDebugFn.mockClear();
        mockErrorFn.mockClear();
    });

    describe('getVoteImages', () => {
        test('should fetch vote images successfully', async () => {
            const mockChallenge = { title: 'Test Challenge', url: 'test-url' };
            const mockToken = 'test-token';
            const mockResponse = {
                images: [
                    { id: 'img1', ratio: 25 },
                    { id: 'img2', ratio: 30 },
                ],
            };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            const result = await getVoteImages(mockChallenge, mockToken);

            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest_mobile/get_vote_images',
                expect.objectContaining({
                    'content-type': 'application/x-www-form-urlencoded',
                }),
                'limit=100&url=test-url',
            );
            expect(result).toEqual(mockResponse);
        });

        test('should return null when no images', async () => {
            const mockChallenge = { title: 'Test Challenge', url: 'test-url' };
            const mockToken = 'test-token';
            const mockResponse = { images: [] };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            const result = await getVoteImages(mockChallenge, mockToken);

            expect(result).toBeNull();
        });
    });

    describe('submitVotes', () => {
        test('should submit votes successfully', async () => {
            const mockVoteImages = {
                challenge: { id: '123', title: 'Test Challenge' },
                voting: { exposure: { exposure_factor: 50 } },
                images: [
                    { id: 'img1', ratio: 25 },
                    { id: 'img2', ratio: 30 },
                    { id: 'img3', ratio: 20 },
                ],
            };
            const mockToken = 'test-token';
            const mockResponse = { success: true };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            const result = await submitVotes(mockVoteImages, mockToken);

            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest_mobile/submit_vote',
                expect.objectContaining({
                    'content-type': 'application/x-www-form-urlencoded',
                }),
                expect.stringContaining('c_id=123'),
            );
            expect(result).toEqual(mockResponse);
        });

        test('should not POST an image-less vote when exposure already meets the target', async () => {
            // Reachable most easily via voteOnNewEntry, which deliberately votes when
            // the challenge-list exposure sits at/above the trigger. If the vote-images
            // endpoint agrees, the selection loop never runs — and submitting anyway
            // would send a vote with no image_ids and log a clean "voted" cycle for
            // zero actual votes, while the caller marks the entry as handled.
            const mockVoteImages = {
                challenge: { id: '123', title: 'Test Challenge' },
                voting: { exposure: { exposure_factor: 100 } },
                images: [{ id: 'img1', ratio: 25 }],
            };

            const result = await submitVotes(mockVoteImages, 'test-token', 90);

            expect(makePostRequest).not.toHaveBeenCalled();
            expect(updateChallengeVoteMetadata).not.toHaveBeenCalled();
            expect(result).toBeUndefined();
            expect(mockWarningFn).toHaveBeenCalledWith(expect.stringContaining('No vote submitted'), null);
        });

        test('should return undefined when no images', async () => {
            const mockVoteImages = {
                challenge: { id: '123', title: 'Test Challenge' },
                voting: { exposure: { exposure_factor: 50 } },
                images: [],
            };
            const mockToken = 'test-token';

            const result = await submitVotes(mockVoteImages, mockToken);

            expect(result).toBeUndefined();
        });

        test('should use custom exposure threshold instead of hardcoded 100', async () => {
            const mockVoteImages = {
                challenge: { id: '123', title: 'Test Challenge' },
                voting: { exposure: { exposure_factor: 50 } },
                images: [
                    { id: 'img1', ratio: 25 },
                    { id: 'img2', ratio: 30 },
                    { id: 'img3', ratio: 20 },
                ],
            };
            const mockToken = 'test-token';
            const customThreshold = 75; // Custom threshold instead of 100
            const mockResponse = { success: true };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            const result = await submitVotes(mockVoteImages, mockToken, customThreshold);

            // The function should continue voting until it reaches the custom threshold (75)
            // Starting at 50, it needs 25 more points to reach 75
            // It should select images until it reaches or exceeds 75
            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest_mobile/submit_vote',
                expect.objectContaining({
                    'content-type': 'application/x-www-form-urlencoded',
                }),
                expect.stringContaining('c_id=123'),
            );
            expect(result).toEqual(mockResponse);
        });

        test('should handle exposure threshold function parameter', async () => {
            const mockVoteImages = {
                challenge: { id: '123', title: 'Test Challenge' },
                voting: { exposure: { exposure_factor: 50 } },
                images: [
                    { id: 'img1', ratio: 25 },
                    { id: 'img2', ratio: 30 },
                ],
            };
            const mockToken = 'test-token';

            // A function target is a legacy caller shape — the orchestrator has passed
            // a resolved number since the exposure-threshold resolver was retired
            // (see the _getExposureThreshold note in api/main.js). `exposure_factor <
            // someFunction` is always false, so no image is ever selected.
            const thresholdFunction = (challengeId) => {
                return challengeId === '123' ? 80 : 100;
            };

            const result = await submitVotes(mockVoteImages, mockToken, thresholdFunction);

            // Previously this submitted a vote carrying no image_ids at all. Sending
            // nothing is the honest outcome for an unusable target.
            expect(makePostRequest).not.toHaveBeenCalled();
            expect(result).toBeUndefined();
            expect(mockWarningFn).toHaveBeenCalledWith(expect.stringContaining('No vote submitted'), null);
        });

        test('should handle insufficient images for target exposure', async () => {
            const mockVoteImages = {
                challenge: { id: '123', title: 'Test Challenge' },
                voting: { exposure: { exposure_factor: 50 } },
                images: [
                    { id: 'img1', ratio: 10 }, // Only one small image available
                ],
            };
            const mockToken = 'test-token';
            const mockResponse = { success: true };
            const targetThreshold = 100; // High threshold that can't be reached

            makePostRequest.mockResolvedValueOnce(mockResponse);

            const result = await submitVotes(mockVoteImages, mockToken, targetThreshold);

            // Should log warning about insufficient images
            expect(mockWarningFn).toHaveBeenCalledWith(
                expect.stringContaining(
                    '[Challenge 123: Test Challenge] Insufficient images to reach 100% exposure (only 1 available)',
                ),
                null,
            );
            expect(result).toEqual(mockResponse);
        });

        test('should handle vote submission failure', async () => {
            const mockVoteImages = {
                challenge: { id: '123', title: 'Test Challenge' },
                voting: { exposure: { exposure_factor: 50 } },
                images: [{ id: 'img1', ratio: 25 }],
            };
            const mockToken = 'test-token';

            makePostRequest.mockResolvedValueOnce(null); // Simulate failure

            const result = await submitVotes(mockVoteImages, mockToken);

            expect(logger.withCategory).toHaveBeenCalledWith('voting');
            expect(mockErrorFn).toHaveBeenCalledWith(
                expect.stringContaining('[Challenge 123: Test Challenge] Vote submission failed'),
                null,
            );
            expect(result).toBeUndefined();
        });

        test('should handle metadata update failure', async () => {
            const mockVoteImages = {
                challenge: { id: '123', title: 'Test Challenge' },
                voting: { exposure: { exposure_factor: 50 } },
                images: [{ id: 'img1', ratio: 25 }],
            };
            const mockToken = 'test-token';
            const mockResponse = { success: true };

            makePostRequest.mockResolvedValueOnce(mockResponse);
            updateChallengeVoteMetadata.mockReturnValueOnce(false); // Simulate metadata update failure

            const result = await submitVotes(mockVoteImages, mockToken);

            expect(mockWarningFn).toHaveBeenCalledWith(
                'Failed to update metadata for [Challenge 123: Test Challenge]',
                null,
            );
            expect(result).toEqual(mockResponse);
        });

        test('should handle metadata update error exception', async () => {
            const mockVoteImages = {
                challenge: { id: '123', title: 'Test Challenge' },
                voting: { exposure: { exposure_factor: 50 } },
                images: [{ id: 'img1', ratio: 25 }],
            };
            const mockToken = 'test-token';
            const mockResponse = { success: true };
            const mockError = new Error('Metadata update error');

            makePostRequest.mockResolvedValueOnce(mockResponse);
            updateChallengeVoteMetadata.mockImplementationOnce(() => {
                throw mockError;
            });

            const result = await submitVotes(mockVoteImages, mockToken);

            expect(mockWarningFn).toHaveBeenCalledWith(
                'Error updating metadata for [Challenge 123: Test Challenge]:',
                mockError,
            );
            expect(result).toEqual(mockResponse);
        });
    });

    // Regression coverage for the vote-selection loop. The original implementation sampled
    // `images` at random and terminated on `uniqueImageIds.size === images.length`, which is
    // unreachable when the endpoint repeats an id — the loop then spun forever, synchronously.
    // These tests are deliberately written against the fixed shape: a synchronous infinite
    // loop cannot be bounded by Jest's testTimeout (that needs a free event loop), so a test
    // that ran the old code would hang the worker rather than fail.
    describe('submitVotes — selection loop', () => {
        const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

        const buildVoteImages = (images, exposureFactor = 0) => ({
            challenge: { id: '123', title: 'Test Challenge' },
            voting: { exposure: { exposure_factor: exposureFactor } },
            images,
        });

        test('terminates and votes each id once when the API repeats an image id', async () => {
            makePostRequest.mockResolvedValueOnce({ success: true });

            await submitVotes(
                buildVoteImages([
                    { id: 'img1', ratio: 1 },
                    { id: 'img1', ratio: 1 },
                    { id: 'img2', ratio: 1 },
                ]),
                'test-token',
            );

            expect(makePostRequest).toHaveBeenCalledTimes(1);
            const body = makePostRequest.mock.calls[0][2];
            expect(countOccurrences(body, '&image_ids[]=img1')).toBe(1);
            expect(countOccurrences(body, '&image_ids[]=img2')).toBe(1);
        });

        test('does not warn about insufficient images when the target was actually reached', async () => {
            makePostRequest.mockResolvedValueOnce({ success: true });

            // Two images at 60% each overshoot the 100% target on the final one. The old
            // exhaustion-based break warned here anyway, reporting a shortfall that never
            // happened.
            await submitVotes(
                buildVoteImages([
                    { id: 'img1', ratio: 60 },
                    { id: 'img2', ratio: 60 },
                ]),
                'test-token',
            );

            expect(mockWarningFn).not.toHaveBeenCalledWith(
                expect.stringContaining('Insufficient images'),
                expect.anything(),
            );
        });

        test('keeps voting when an image carries no usable ratio', async () => {
            makePostRequest.mockResolvedValueOnce({ success: true });

            // `exposure_factor += undefined` yields NaN, and `NaN < target` is false — so the
            // old loop stopped after a single image and submitted a near-empty ballot silently.
            await submitVotes(buildVoteImages([{ id: 'img1' }, { id: 'img2' }, { id: 'img3' }]), 'test-token');

            const body = makePostRequest.mock.calls[0][2];
            expect(countOccurrences(body, '&image_ids[]=')).toBe(3);
            expect(mockWarningFn).toHaveBeenCalledWith(expect.stringContaining('no usable exposure ratio'), null);
        });

        test('still warns when the pool genuinely cannot reach the target', async () => {
            makePostRequest.mockResolvedValueOnce({ success: true });

            await submitVotes(
                buildVoteImages([
                    { id: 'img1', ratio: 1 },
                    { id: 'img2', ratio: 1 },
                ]),
                'test-token',
            );

            expect(mockWarningFn).toHaveBeenCalledWith(expect.stringContaining('Insufficient images'), null);
        });
    });
});
