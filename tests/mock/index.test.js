/**
 * Tests for mock/index.js
 *
 * Tests the mock data system and API client simulation.
 */

const mockIndex = require('../../src/js/mock/index');
const cancellation = require('../../src/js/voting/cancellation');

// Mock the individual mock modules
jest.mock('../../src/js/mock/auth', () => ({
    mockLoginSuccess: { token: 'mock-auth-token', success: true },
    mockLoginFailure: { error: 'Invalid credentials', success: false },
}));

jest.mock('../../src/js/mock/challenges', () => ({
    mockActiveChallenges: { challenges: [{ id: '1', title: 'Test Challenge' }] },
    generateMockChallenges: jest.fn(() => ({ challenges: [{ id: '2', title: 'Generated Challenge' }] })),
}));

jest.mock('../../src/js/mock/voting', () => ({
    mockVoteImagesByChallenge: {
        'challenge-1': { images: [{ id: 'img1', ratio: 25 }] },
    },
    mockEmptyVoteImages: { images: [] },
    mockVoteSubmissionSuccess: { success: true, votes: 5 },
    mockVoteSubmissionFailure: { error: 'Vote submission failed' },
    generateMockVoteImages: jest.fn(() => ({ images: [{ id: 'generated-img', ratio: 30 }] })),
}));

jest.mock('../../src/js/mock/boost', () => ({
    mockBoostSuccess: { success: true, boost_applied: true },
    mockBoostFailure: { error: 'Boost failed' },
    mockBoostAlreadyUsed: { error: 'Boost already used' },
}));

jest.mock('../../src/js/mock/errors', () => ({
    mockAuthErrors: {
        invalidToken: { error: 'Invalid token', code: 401 },
    },
}));

// Mock console methods
jest.spyOn(console, 'log').mockImplementation();
jest.spyOn(console, 'warn').mockImplementation();

// Mock logger with shared mock functions defined inside
jest.mock('../../src/js/logger', () => {
    // Create shared mock functions inside the mock factory
    const mockDebugFn = jest.fn();
    const mockInfoFn = jest.fn();
    const mockSuccessFn = jest.fn();
    const mockErrorFn = jest.fn();
    const mockApiFn = jest.fn();

    const mock = {
        debug: jest.fn(),
        info: jest.fn(),
        success: jest.fn(),
        error: jest.fn(),
        api: jest.fn(),
        startOperation: jest.fn(),
        endOperation: jest.fn(),
        apiRequest: jest.fn(),
        apiResponse: jest.fn(),
        isDevMode: jest.fn(() => false),
        challengeTag: jest.fn((c) => `[Challenge ${c?.id ?? 'unknown'}]`),
        // Export the shared functions for access in tests
        __mockDebugFn: mockDebugFn,
        __mockInfoFn: mockInfoFn,
        __mockSuccessFn: mockSuccessFn,
        __mockErrorFn: mockErrorFn,
        __mockApiFn: mockApiFn,
    };

    mock.withCategory = jest.fn(() => ({
        info: mockInfoFn,
        error: mockErrorFn,
        debug: mockDebugFn,
        success: mockSuccessFn,
        warning: jest.fn(),
        api: mockApiFn,
        progress: jest.fn(),
        startOperation: jest.fn(),
        endOperation: jest.fn(),
    }));

    return mock;
});

describe('mock/index', () => {
    const auth = require('../../src/js/mock/auth');
    const challenges = require('../../src/js/mock/challenges');
    const voting = require('../../src/js/mock/voting');
    const boost = require('../../src/js/mock/boost');
    const errors = require('../../src/js/mock/errors');
    const logger = require('../../src/js/logger');

    beforeEach(() => {
        jest.clearAllMocks();
        logger.__mockDebugFn.mockClear();
        logger.__mockInfoFn.mockClear();
        logger.__mockSuccessFn.mockClear();
        logger.__mockErrorFn.mockClear();
        logger.__mockApiFn.mockClear();
        // Reset cancellation flag
        cancellation.setCancelled(false);
    });

    describe('module exports', () => {
        test('should export individual mock modules', () => {
            expect(mockIndex.auth).toBe(auth);
            expect(mockIndex.challenges).toBe(challenges);
            expect(mockIndex.voting).toBe(voting);
            expect(mockIndex.boost).toBe(boost);
            expect(mockIndex.errors).toBe(errors);
        });

        test('should export mockData object with all modules', () => {
            expect(mockIndex.mockData).toEqual({
                auth,
                challenges,
                voting,
                boost,
                errors,
            });
        });

        test('should export utility functions', () => {
            expect(typeof mockIndex.getMockData).toBe('function');
            expect(typeof mockIndex.simulateApiResponse).toBe('function');
            expect(typeof mockIndex.simulateApiError).toBe('function');
            expect(typeof mockIndex.mockApiClient).toBe('object');
        });
    });

    describe('getMockData', () => {
        test('should return correct mock data by type', () => {
            const authData = mockIndex.getMockData('auth');
            const challengesData = mockIndex.getMockData('challenges');

            expect(authData).toBe(auth);
            expect(challengesData).toBe(challenges);
        });

        test('should return specific scenario data', () => {
            auth.specificScenario = { test: 'data' };

            const scenarioData = mockIndex.getMockData('auth', 'specificScenario');

            expect(scenarioData).toEqual({ test: 'data' });
        });

        test('should throw error for unknown type', () => {
            expect(() => mockIndex.getMockData('unknown')).toThrow('Unknown mock data type: unknown');
        });

        test('should throw error for unknown scenario', () => {
            expect(() => mockIndex.getMockData('auth', 'unknownScenario')).toThrow(
                'Unknown scenario "unknownScenario" for type "auth"',
            );
        });
    });

    describe('simulateApiResponse', () => {
        test('should resolve with data after delay', async () => {
            const testData = { test: 'response' };
            const startTime = Date.now();

            const result = await mockIndex.simulateApiResponse(testData, 100);

            const endTime = Date.now();
            expect(result).toEqual(testData);
            expect(endTime - startTime).toBeGreaterThanOrEqual(90); // Allow 10ms tolerance for CI timing precision
        });

        test('should use default delay of 1000ms', async () => {
            const testData = { test: 'response' };
            const startTime = Date.now();

            const result = await mockIndex.simulateApiResponse(testData);

            const endTime = Date.now();
            expect(result).toEqual(testData);
            expect(endTime - startTime).toBeGreaterThanOrEqual(990); // Allow 10ms tolerance for CI timing precision
        });
    });

    describe('simulateApiError', () => {
        test('should reject with error after delay', async () => {
            const testError = new Error('Test error');
            const startTime = Date.now();

            await expect(mockIndex.simulateApiError(testError, 100)).rejects.toThrow('Test error');

            const endTime = Date.now();
            expect(endTime - startTime).toBeGreaterThanOrEqual(90); // Allow 10ms tolerance for CI timing precision
        });

        test('should use default delay of 500ms', async () => {
            const testError = new Error('Test error');
            const startTime = Date.now();

            await expect(mockIndex.simulateApiError(testError)).rejects.toThrow('Test error');

            const endTime = Date.now();
            expect(endTime - startTime).toBeGreaterThanOrEqual(490); // Allow 10ms tolerance for CI timing precision
        });
    });

    describe('mockApiClient', () => {
        describe('authenticate', () => {
            test('should return success for valid credentials', async () => {
                const result = await mockIndex.mockApiClient.authenticate('test@example.com', 'password');

                expect(result).toEqual(auth.mockLoginSuccess);
                expect(logger.__mockDebugFn).toHaveBeenCalledWith(
                    'Mock authentication with: test@example.com, password: [hidden]',
                    null,
                );
                expect(logger.__mockSuccessFn).toHaveBeenCalledWith('Mock authentication successful', null, null);
            });

            test('should return failure for empty email', async () => {
                await expect(mockIndex.mockApiClient.authenticate('', 'password')).rejects.toEqual(
                    auth.mockLoginFailure,
                );

                expect(logger.__mockErrorFn).toHaveBeenCalledWith(
                    'Mock authentication failed - empty credentials',
                    null,
                );
            });

            test('should return failure for empty password', async () => {
                await expect(mockIndex.mockApiClient.authenticate('test@example.com', '')).rejects.toEqual(
                    auth.mockLoginFailure,
                );

                expect(logger.__mockErrorFn).toHaveBeenCalledWith(
                    'Mock authentication failed - empty credentials',
                    null,
                );
            });

            test('should handle whitespace-only credentials', async () => {
                await expect(mockIndex.mockApiClient.authenticate('   ', '   ')).rejects.toEqual(auth.mockLoginFailure);

                expect(logger.__mockErrorFn).toHaveBeenCalledWith(
                    'Mock authentication failed - empty credentials',
                    null,
                );
            });

            test('should log password as hidden when provided', async () => {
                await mockIndex.mockApiClient.authenticate('test@example.com', 'mypassword');

                expect(logger.__mockDebugFn).toHaveBeenCalledWith(
                    'Mock authentication with: test@example.com, password: [hidden]',
                    null,
                );
            });

            test('should log no password when not provided', async () => {
                await expect(mockIndex.mockApiClient.authenticate('test@example.com', null)).rejects.toEqual(
                    auth.mockLoginFailure,
                );

                expect(logger.__mockDebugFn).toHaveBeenCalledWith(
                    'Mock authentication with: test@example.com, password: no password',
                    null,
                );
            });
        });

        describe('getActiveChallenges', () => {
            test('should return challenges for any token', async () => {
                const result = await mockIndex.mockApiClient.getActiveChallenges('any-token');

                expect(result).toEqual({ challenges: [{ id: '2', title: 'Generated Challenge' }] });
                expect(logger.__mockApiFn).toHaveBeenCalledWith('Mock getActiveChallenges', null);
            });

            test('should generate fresh challenges if generator exists', async () => {
                // Clear the session cache to ensure the generator is called
                mockIndex.clearSessionCache();

                challenges.generateMockChallenges.mockReturnValueOnce({
                    challenges: [
                        {
                            id: 'fresh',
                            title: 'Fresh Challenge',
                        },
                    ],
                });

                const result = await mockIndex.mockApiClient.getActiveChallenges('test-token');

                expect(challenges.generateMockChallenges).toHaveBeenCalled();
                expect(result).toEqual({ challenges: [{ id: 'fresh', title: 'Fresh Challenge' }] });
            });

            test('should resolve an empty challenge list for missing token (real-API parity)', async () => {
                // The real getActiveChallenges never rejects — it resolves
                // { challenges: [] } on failure. The mock must match so
                // callers behave identically in both modes.
                await expect(mockIndex.mockApiClient.getActiveChallenges(null)).resolves.toEqual({ challenges: [] });

                expect(logger.__mockErrorFn).toHaveBeenCalledWith('No token provided, returning empty result', null);
            });

            test('should log token information', async () => {
                await mockIndex.mockApiClient.getActiveChallenges('test-token-123');

                expect(logger.__mockDebugFn).toHaveBeenCalledWith('Token provided: true', null);
                expect(logger.__mockDebugFn).toHaveBeenCalledWith('Token starts with mock_: false', null);
            });
        });

        describe('getVoteImages', () => {
            test('should return vote images for challenge', async () => {
                const challenge = { title: 'Test Challenge', url: 'challenge-1' };

                const result = await mockIndex.mockApiClient.getVoteImages(challenge, 'test-token');

                expect(result).toEqual({ images: [{ id: 'generated-img', ratio: 30 }] });
                expect(logger.__mockApiFn).toHaveBeenCalledWith('Mock getVoteImages', null);
                expect(logger.__mockDebugFn).toHaveBeenCalledWith('Challenge: Test Challenge', null);
            });

            test('should generate fresh vote images if generator exists', async () => {
                const challenge = { title: 'Test Challenge', url: 'test-url' };
                voting.generateMockVoteImages.mockReturnValueOnce({ images: [{ id: 'fresh-img', ratio: 20 }] });

                const result = await mockIndex.mockApiClient.getVoteImages(challenge, 'test-token');

                expect(voting.generateMockVoteImages).toHaveBeenCalledWith('test-url', challenge);
                expect(result).toEqual({ images: [{ id: 'fresh-img', ratio: 20 }] });
            });

            test('should return empty images for unknown challenge', async () => {
                const challenge = { title: 'Unknown Challenge', url: 'unknown-url' };

                // Mock generateMockVoteImages to return empty for this test
                voting.generateMockVoteImages.mockReturnValueOnce(voting.mockEmptyVoteImages);

                const result = await mockIndex.mockApiClient.getVoteImages(challenge, 'test-token');

                expect(result).toEqual(voting.mockEmptyVoteImages);
            });

            test('should resolve null for missing token (real-API parity)', async () => {
                const challenge = { title: 'Test Challenge', url: 'challenge-1' };

                // Real getVoteImages resolves null on failure — never rejects.
                await expect(mockIndex.mockApiClient.getVoteImages(challenge, null)).resolves.toBeNull();
            });
        });

        describe('submitVotes', () => {
            test('should submit votes successfully', async () => {
                const voteImages = { images: [{ id: 'img1', ratio: 25 }] };

                const result = await mockIndex.mockApiClient.submitVotes(voteImages, 'test-token');

                expect(result).toEqual(voting.mockVoteSubmissionSuccess);
                expect(logger.__mockApiFn).toHaveBeenCalledWith('Mock submitVotes', null);
                // Note: 'Submitting mock votes successfully' was removed from the mock implementation
            });

            test('should return error for empty images', async () => {
                const voteImages = { images: [] };

                await expect(mockIndex.mockApiClient.submitVotes(voteImages, 'test-token')).rejects.toEqual(
                    voting.mockVoteSubmissionFailure,
                );

                // Note: This error message was changed to use logger.error
            });

            test('should resolve undefined for missing token (real-API parity)', async () => {
                const voteImages = { images: [{ id: 'img1', ratio: 25 }] };

                // Real submitVotes bare-returns on failure — never rejects.
                await expect(mockIndex.mockApiClient.submitVotes(voteImages, null)).resolves.toBeUndefined();
            });
        });

        describe('applyBoost', () => {
            test('should apply boost successfully when available', async () => {
                const challenge = {
                    title: 'Test Challenge',
                    member: { boost: { state: 'AVAILABLE' } },
                };

                const result = await mockIndex.mockApiClient.applyBoost(challenge, 'test-token');

                expect(result).toEqual(boost.mockBoostSuccess);
                expect(logger.__mockApiFn).toHaveBeenCalledWith('Mock applyBoost', null);
                // Note: 'Applying boost successfully' message was not migrated to logger
            });

            test('should return error when boost already used', async () => {
                const challenge = {
                    title: 'Test Challenge',
                    member: { boost: { state: 'USED' } },
                };

                await expect(mockIndex.mockApiClient.applyBoost(challenge, 'test-token')).rejects.toEqual(
                    boost.mockBoostAlreadyUsed,
                );

                // Note: 'Boost already used' message was not migrated to logger
            });

            test('should return error when boost not available', async () => {
                const challenge = {
                    title: 'Test Challenge',
                    member: { boost: { state: 'NOT_AVAILABLE' } },
                };

                await expect(mockIndex.mockApiClient.applyBoost(challenge, 'test-token')).rejects.toEqual(
                    boost.mockBoostFailure,
                );

                // Note: 'Boost not available' message was not migrated to logger
            });
        });

        describe('applyBoostToEntry', () => {
            test('should apply boost to entry successfully', async () => {
                const result = await mockIndex.mockApiClient.applyBoostToEntry('123', 'img456', 'test-token');

                expect(result).toEqual(boost.mockBoostSuccess);
                // Note: This was changed to logger.api('Mock applyBoostToEntry')
                // Note: This message was not migrated to logger in the implementation
            });

            test('should resolve null for missing token (real-API parity)', async () => {
                // Real applyBoostToEntry resolves null on failure — never rejects.
                await expect(mockIndex.mockApiClient.applyBoostToEntry('123', 'img456', null)).resolves.toBeNull();
            });
        });

        describe('fetchChallengesAndVote', () => {
            beforeEach(() => {
                // The shared orchestration fetches through
                // mockApiClient.getActiveChallenges (session-cached, prefers
                // generateMockChallenges) — route it at the per-test fixture.
                mockIndex.clearSessionCache();
                challenges.generateMockChallenges.mockImplementation(() => challenges.mockActiveChallenges);
            });

            test('should complete voting process successfully', async () => {
                // Mock challenges with proper structure for the voting process
                challenges.mockActiveChallenges = {
                    challenges: [
                        {
                            id: '1',
                            title: 'Test Challenge',
                            url: 'test-url',
                            member: {
                                boost: { state: 'AVAILABLE' },
                                ranking: {
                                    exposure: { exposure_factor: 50 },
                                },
                            },
                        },
                    ],
                };

                const result = await mockIndex.mockApiClient.fetchChallengesAndVote('test-token');

                // `challenges` carries the full active list (parity with real main.js)
                // so callers can reuse it for threshold scheduling.
                expect(result).toEqual({
                    success: true,
                    message: 'Voting process completed successfully',
                    challenges: expect.any(Array),
                });
                // The mock binder logs its preamble, then runs the SHARED path.
                expect(logger.__mockApiFn).toHaveBeenCalledWith('Mock fetchChallengesAndVote', null);
            });

            test('should handle cancellation during voting process', async () => {
                cancellation.setCancelled(true);

                const result = await mockIndex.mockApiClient.fetchChallengesAndVote('test-token');

                expect(result).toEqual({
                    success: false,
                    message: 'Voting cancelled by user',
                    challenges: expect.any(Array),
                });
            });

            test('should complete an empty pass for missing token (real-API parity)', async () => {
                // Real fetchChallengesAndVote has no token guard: the pass
                // runs, finds no challenges, and completes — never rejects.
                await expect(mockIndex.mockApiClient.fetchChallengesAndVote(null)).resolves.toEqual({
                    success: true,
                    message: 'No active challenges found',
                    challenges: [],
                });
            });

            test('never runs stale-metadata cleanup (shared un-namespaced store)', async () => {
                // Mock ids never match real challenge ids, so a mock cycle
                // running cleanupStaleMetadata would purge the user's REAL
                // voting metadata. The binder must inject null for it.
                const metadata = require('../../src/js/metadata');
                const cleanupSpy = jest.spyOn(metadata, 'cleanupStaleMetadata');

                const result = await mockIndex.mockApiClient.fetchChallengesAndVote('test-token');

                expect(result.success).toBe(true);
                expect(cleanupSpy).not.toHaveBeenCalled();
                cleanupSpy.mockRestore();
            });

            test('never persists new-entry snapshots to the shared metadata store', async () => {
                // Same reasoning as cleanupStaleMetadata above: mock challenge ids
                // never match real ones, and mock passes cleanupStaleMetadata: null,
                // so a metadata-backed tracker here would pile up entryIds in the
                // user's REAL metadata.json that nothing would ever prune. The mock
                // binder must inject the in-memory tracker.
                const metadata = require('../../src/js/metadata');
                const settings = require('../../src/js/settings');
                const setSpy = jest.spyOn(metadata, 'setChallengeEntryIds');
                const getSpy = jest.spyOn(metadata, 'getChallengeEntryIds');
                // Two things have to be true for this assertion to mean anything, and
                // neither holds by default:
                //   1. the gate must be open — at the schema default (false) nothing is
                //      tracked regardless of which tracker is wired in;
                //   2. the challenge must carry a real `entries` array — readEntryIds
                //      returns null without one, so the tracker is never consulted.
                // The shared `mockActiveChallenges` object is overwritten in place by an
                // earlier test in this file with a fixture that has no `entries`, and
                // clearAllMocks does not restore plain data, so this test seeds its own.
                challenges.mockActiveChallenges = {
                    challenges: [
                        {
                            id: 'mock-entry-tracking',
                            title: 'Entry Tracking',
                            url: 'test-url',
                            member: {
                                boost: { state: 'LOCKED' },
                                ranking: {
                                    entries: [{ id: 'e1' }, { id: 'e2' }],
                                    exposure: { exposure_factor: 50 },
                                },
                            },
                        },
                    ],
                };
                const realGet = settings.getEffectiveSetting;
                const settingsSpy = jest
                    .spyOn(settings, 'getEffectiveSetting')
                    .mockImplementation((key, cid) =>
                        key === 'voteOnNewEntry' ? true : realGet.call(settings, key, cid),
                    );

                try {
                    // Pin the precondition, so this stays a real assertion: if a future
                    // fixture change drops `entries` again, fail here rather than
                    // silently passing because the tracker was never reached.
                    const { readEntryIds } = require('../../src/js/services/newEntryTracker');
                    expect(readEntryIds(challenges.mockActiveChallenges.challenges[0])).toEqual(['e1', 'e2']);

                    const result = await mockIndex.mockApiClient.fetchChallengesAndVote('test-token');

                    expect(result.success).toBe(true);
                    // The in-memory tracker WAS exercised (the guards above hold), and
                    // still nothing reached the shared metadata store.
                    expect(setSpy).not.toHaveBeenCalled();
                    expect(getSpy).not.toHaveBeenCalled();
                } finally {
                    settingsSpy.mockRestore();
                    setSpy.mockRestore();
                    getSpy.mockRestore();
                }
            });
        });

        describe('fetchChallengesAndVote — fill-new options', () => {
            const settings = require('../../src/js/settings');

            beforeEach(() => {
                mockIndex.clearSessionCache();
                challenges.generateMockChallenges.mockImplementation(() => challenges.mockActiveChallenges);
            });

            const fillableChallenge = (over = {}) => {
                const now = Math.floor(Date.now() / 1000);
                return {
                    id: '1',
                    title: 'Fillable',
                    url: 'no-vote-images-url', // not in mockVoteImagesByChallenge → no vote submit
                    close_time: now + 600,
                    max_photo_submits: 4,
                    member: {
                        boost: { state: 'AVAILABLE', timeout: now + 120 },
                        turbo: { state: 'NONE' },
                        ranking: { entries: [{ id: 'e1' }], exposure: { exposure_factor: 100 } },
                    },
                    ...over,
                };
            };

            // Override only the toggle keys under test; delegate everything else
            // (tags, exposure, turbo timing) to the real schema defaults so the
            // shared picker and voting logic behave normally.
            const stubToggles = (toggles) => {
                const realGet = settings.getEffectiveSetting;
                jest.spyOn(settings, 'getEffectiveSetting').mockImplementation((key, cid) =>
                    key in toggles ? toggles[key] : realGet.call(settings, key, cid),
                );
            };

            afterEach(() => jest.restoreAllMocks());

            test('boost fill-new submits a fresh photo and boosts that entry', async () => {
                challenges.mockActiveChallenges = { challenges: [fillableChallenge()] };
                stubToggles({ boostFillNew: true, useTurbo: false, turboFillNew: false });
                const submitSpy = jest.spyOn(mockIndex.mockApiClient, 'submitToChallenge');
                const boostEntrySpy = jest.spyOn(mockIndex.mockApiClient, 'applyBoostToEntry');
                const boostSpy = jest.spyOn(mockIndex.mockApiClient, 'applyBoost');

                const result = await mockIndex.mockApiClient.fetchChallengesAndVote('test-token');

                expect(result.success).toBe(true);
                expect(submitSpy).toHaveBeenCalledTimes(1);
                const submittedId = submitSpy.mock.calls[0][1][0];
                expect(boostEntrySpy).toHaveBeenCalledWith('1', submittedId, 'test-token');
                expect(boostSpy).not.toHaveBeenCalled();
            });

            test('boost fill-new falls back to applyBoost when the challenge is full', async () => {
                challenges.mockActiveChallenges = {
                    challenges: [fillableChallenge({ max_photo_submits: 1 })], // 1 entry already → full
                };
                stubToggles({ boostFillNew: true, useTurbo: false, turboFillNew: false });
                const submitSpy = jest.spyOn(mockIndex.mockApiClient, 'submitToChallenge');
                const boostEntrySpy = jest.spyOn(mockIndex.mockApiClient, 'applyBoostToEntry');
                const boostSpy = jest.spyOn(mockIndex.mockApiClient, 'applyBoost');

                await mockIndex.mockApiClient.fetchChallengesAndVote('test-token');

                expect(submitSpy).not.toHaveBeenCalled();
                expect(boostEntrySpy).not.toHaveBeenCalled();
                expect(boostSpy).toHaveBeenCalledTimes(1);
            });

            test('turbo fill-new submits a fresh photo and applies turbo to it', async () => {
                challenges.mockActiveChallenges = {
                    challenges: [
                        fillableChallenge({
                            member: {
                                boost: { state: 'LOCKED', timeout: 0 }, // isolate from boost
                                turbo: { state: 'WON' },
                                ranking: { entries: [{ id: 'e1' }], exposure: { exposure_factor: 100 } },
                            },
                        }),
                    ],
                };
                stubToggles({ boostFillNew: false, useTurbo: true, turboFillNew: true });
                const submitSpy = jest.spyOn(mockIndex.mockApiClient, 'submitToChallenge');
                const turboSpy = jest.spyOn(mockIndex.mockApiClient, 'applyTurbo');

                await mockIndex.mockApiClient.fetchChallengesAndVote('test-token');

                expect(submitSpy).toHaveBeenCalledTimes(1);
                const submittedId = submitSpy.mock.calls[0][1][0];
                expect(turboSpy).toHaveBeenCalledWith('1', submittedId, 'test-token');
            });

            test('both fill-new toggles in one cycle consume only one free slot (no double-submit)', async () => {
                const now = Math.floor(Date.now() / 1000);
                challenges.mockActiveChallenges = {
                    challenges: [
                        {
                            id: '1',
                            title: 'OneSlot',
                            url: 'no-vote-images-url',
                            close_time: now + 600,
                            max_photo_submits: 2, // 1 entry below → exactly one free slot
                            member: {
                                boost: { state: 'AVAILABLE', timeout: now + 120 },
                                turbo: { state: 'WON' },
                                ranking: { entries: [{ id: 'e1' }], exposure: { exposure_factor: 100 } },
                            },
                        },
                    ],
                };
                stubToggles({
                    boostFillNew: true,
                    useTurbo: true,
                    turboFillNew: true,
                    turboApplyWhenBoostActive: true, // boost window is open this cycle
                });
                const submitSpy = jest.spyOn(mockIndex.mockApiClient, 'submitToChallenge');
                const boostEntrySpy = jest.spyOn(mockIndex.mockApiClient, 'applyBoostToEntry');
                const boostSpy = jest.spyOn(mockIndex.mockApiClient, 'applyBoost');
                const turboSpy = jest.spyOn(mockIndex.mockApiClient, 'applyTurbo');

                await mockIndex.mockApiClient.fetchChallengesAndVote('test-token');

                // Deadline actions run in timer order (largest window first) on the
                // shared path — with default timers (turboTime 7200 > boostTime 3600)
                // TURBO acts first and consumes the only free slot (reflectNewEntry
                // updates the local entries), so boost fill-new sees no-slots and
                // falls back to boosting via applyBoost. Exactly one submit total.
                expect(submitSpy).toHaveBeenCalledTimes(1);
                const submittedId = submitSpy.mock.calls[0][1][0];
                expect(turboSpy).toHaveBeenCalledWith('1', submittedId, 'test-token');
                expect(boostEntrySpy).not.toHaveBeenCalled();
                expect(boostSpy).toHaveBeenCalledTimes(1);
            });
        });
    });
});
