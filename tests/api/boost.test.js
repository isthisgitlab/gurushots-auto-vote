/**
 * Tests for boost.js
 *
 * Tests the boost application functionality.
 */

const {applyBoost, applyBoostToEntry} = require('../../src/js/api/boost');

// Mock the api-client module
jest.mock('../../src/js/api/api-client', () => ({
    makePostRequest: jest.fn(),
    createCommonHeaders: jest.fn((token) => ({
        'x-token': token || 'mock-token',
        'user-agent': 'GuruShots/1.0 (iPhone; iOS 16.0; en_US)',
        'accept': 'application/json',
    })),
    FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded; charset=utf-8'
}));

// Mock console methods
jest.spyOn(console, 'log').mockImplementation();
jest.spyOn(console, 'error').mockImplementation();

describe('boost', () => {
    const mockToken = 'test-token-123';
    const {makePostRequest, createCommonHeaders} = require('../../src/js/api/api-client');

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('applyBoost', () => {
        const mockChallenge = {
            id: '12345',
            title: 'Test Challenge',
            member: {
                ranking: {
                    entries: [
                        {id: 'entry1', turbo: true},
                        {id: 'entry2', turbo: false},
                        {id: 'entry3', turbo: false}
                    ]
                }
            }
        };

        test('should apply boost to first non-turboed entry successfully', async () => {
            const mockResponse = {success: true, boosted_entry: 'entry2'};
            makePostRequest.mockResolvedValueOnce(mockResponse);

            const result = await applyBoost(mockChallenge, mockToken);

            expect(createCommonHeaders).toHaveBeenCalledWith(mockToken);
            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest_mobile/boost_photo',
                expect.objectContaining({
                    'x-token': mockToken,
                    'content-type': 'application/x-www-form-urlencoded; charset=utf-8'
                }),
                'c_id=12345&image_id=entry2'
            );

            expect(result).toEqual(mockResponse);
            expect(console.log).toHaveBeenCalledWith('Boost applied successfully to image ID: entry2');
        });

        test('should return null when no non-turboed entries found', async () => {
            const challengeAllTurboed = {
                ...mockChallenge,
                member: {
                    ranking: {
                        entries: [
                            {id: 'entry1', turbo: true},
                            {id: 'entry2', turbo: true},
                            {id: 'entry3', turbo: true}
                        ]
                    }
                }
            };

            const result = await applyBoost(challengeAllTurboed, mockToken);

            expect(result).toBeNull();
            expect(makePostRequest).not.toHaveBeenCalled();
            expect(console.error).toHaveBeenCalledWith('No non-turboed entries found for boosting.');
        });

        test('should return null when entries array is empty', async () => {
            const challengeEmptyEntries = {
                ...mockChallenge,
                member: {
                    ranking: {
                        entries: []
                    }
                }
            };

            const result = await applyBoost(challengeEmptyEntries, mockToken);

            expect(result).toBeNull();
            expect(makePostRequest).not.toHaveBeenCalled();
            expect(console.error).toHaveBeenCalledWith('No non-turboed entries found for boosting.');
        });

        test('should return undefined when request fails', async () => {
            makePostRequest.mockResolvedValueOnce(null);

            const result = await applyBoost(mockChallenge, mockToken);

            expect(result).toBeUndefined();
            expect(console.error).toHaveBeenCalledWith('Failed to apply boost for challenge ID: 12345');
        });

        test('should find first non-turboed entry when some are turboed', async () => {
            const challengeMixedEntries = {
                ...mockChallenge,
                member: {
                    ranking: {
                        entries: [
                            {id: 'entry1', turbo: true},
                            {id: 'entry2', turbo: true},
                            {id: 'entry3', turbo: false},
                            {id: 'entry4', turbo: false}
                        ]
                    }
                }
            };

            const mockResponse = {success: true};
            makePostRequest.mockResolvedValueOnce(mockResponse);

            await applyBoost(challengeMixedEntries, mockToken);

            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest_mobile/boost_photo',
                expect.anything(),
                'c_id=12345&image_id=entry3'
            );
        });

        test('should handle entry with turbo as false explicitly', async () => {
            const challengeExplicitFalse = {
                ...mockChallenge,
                member: {
                    ranking: {
                        entries: [
                            {id: 'entry1', turbo: false}
                        ]
                    }
                }
            };

            const mockResponse = {success: true};
            makePostRequest.mockResolvedValueOnce(mockResponse);

            await applyBoost(challengeExplicitFalse, mockToken);

            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest_mobile/boost_photo',
                expect.anything(),
                'c_id=12345&image_id=entry1'
            );
        });

        test('should handle entry without turbo property (falsy)', async () => {
            const challengeNoTurboProperty = {
                ...mockChallenge,
                member: {
                    ranking: {
                        entries: [
                            {id: 'entry1'} // No turbo property
                        ]
                    }
                }
            };

            const mockResponse = {success: true};
            makePostRequest.mockResolvedValueOnce(mockResponse);

            await applyBoost(challengeNoTurboProperty, mockToken);

            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest_mobile/boost_photo',
                expect.anything(),
                'c_id=12345&image_id=entry1'
            );
        });
    });

    describe('applyBoostToEntry', () => {
        test('should apply boost to specific entry successfully', async () => {
            const mockResponse = {success: true, boosted_entry: 'specific-image-123'};
            makePostRequest.mockResolvedValueOnce(mockResponse);

            const result = await applyBoostToEntry('67890', 'specific-image-123', mockToken);

            expect(createCommonHeaders).toHaveBeenCalledWith(mockToken);
            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest_mobile/boost_photo',
                expect.objectContaining({
                    'x-token': mockToken,
                    'content-type': 'application/x-www-form-urlencoded; charset=utf-8'
                }),
                'c_id=67890&image_id=specific-image-123'
            );

            expect(result).toEqual(mockResponse);
            expect(console.log).toHaveBeenCalledWith('Boost applied successfully to image ID: specific-image-123 in challenge 67890');
        });

        test('should return null when request fails', async () => {
            makePostRequest.mockResolvedValueOnce(null);

            const result = await applyBoostToEntry('67890', 'specific-image-123', mockToken);

            expect(result).toBeNull();
            expect(console.error).toHaveBeenCalledWith('Failed to apply boost for challenge ID: 67890, image ID: specific-image-123');
        });

        test('should handle numeric challenge ID', async () => {
            const mockResponse = {success: true};
            makePostRequest.mockResolvedValueOnce(mockResponse);

            await applyBoostToEntry(12345, 'image-456', mockToken);

            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest_mobile/boost_photo',
                expect.anything(),
                'c_id=12345&image_id=image-456'
            );
        });

        test('should handle special characters in IDs', async () => {
            const mockResponse = {success: true};
            makePostRequest.mockResolvedValueOnce(mockResponse);

            await applyBoostToEntry('challenge&special', 'image=special', mockToken);

            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest_mobile/boost_photo',
                expect.anything(),
                'c_id=challenge&special&image_id=image=special'
            );
        });

        test('should use same endpoint as applyBoost', async () => {
            const mockResponse = {success: true};
            makePostRequest.mockResolvedValueOnce(mockResponse);

            await applyBoostToEntry('test-challenge', 'test-image', mockToken);

            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest_mobile/boost_photo',
                expect.anything(),
                expect.any(String)
            );
        });

        test('should include correct headers', async () => {
            const mockResponse = {success: true};
            makePostRequest.mockResolvedValueOnce(mockResponse);

            await applyBoostToEntry('test-challenge', 'test-image', mockToken);

            expect(makePostRequest).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    'x-token': mockToken,
                    'content-type': 'application/x-www-form-urlencoded; charset=utf-8'
                }),
                expect.any(String)
            );
        });
    });
});