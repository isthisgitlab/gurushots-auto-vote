/**
 * Tests for login.js
 *
 * Tests the authentication functionality.
 */

const { authenticate } = require('../../src/js/api/login');

// Mock the api-client module — login now routes through makePostRequest so the
// CapacitorHttp adapter applies on Android.
jest.mock('../../src/js/api/api-client', () => ({
    makePostRequest: jest.fn(),
    createCommonHeaders: jest.fn((token) => ({
        'x-token': token || 'mock-token',
        'user-agent': 'GuruShots/1.0 (iPhone; iOS 16.0; en_US)',
        accept: 'application/json',
    })),
    FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded; charset=utf-8',
}));

const mockInfoFn = jest.fn();
const mockErrorFn = jest.fn();
const mockSuccessFn = jest.fn();
const mockWarningFn = jest.fn();
const mockDebugFn = jest.fn();
const mockApiFn = jest.fn();
const mockApiRequestFn = jest.fn();

jest.mock('../../src/js/logger', () => ({
    info: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    debug: jest.fn(),
    apiRequest: jest.fn(),
    apiResponse: jest.fn(),
    api: jest.fn(),
    withCategory: jest.fn(() => ({
        info: mockInfoFn,
        error: mockErrorFn,
        success: mockSuccessFn,
        warning: mockWarningFn,
        debug: mockDebugFn,
        api: mockApiFn,
        apiRequest: mockApiRequestFn,
        startOperation: jest.fn(),
        endOperation: jest.fn(),
        progress: jest.fn(),
    })),
}));

describe('login', () => {
    const mockEmail = 'test@example.com';
    const mockPassword = 'testpassword123';
    const { makePostRequest, createCommonHeaders } = require('../../src/js/api/api-client');
    const logger = require('../../src/js/logger');
    const SIGNUP_URL = 'https://api.gurushots.com/rest_mobile/signup';

    beforeEach(() => {
        jest.clearAllMocks();
        mockInfoFn.mockClear();
        mockErrorFn.mockClear();
        mockSuccessFn.mockClear();
        mockWarningFn.mockClear();
        mockDebugFn.mockClear();
    });

    describe('authenticate', () => {
        test('should authenticate successfully with valid credentials', async () => {
            const mockData = {
                token: 'auth-token-123',
                user: {
                    id: '12345',
                    email: mockEmail,
                    name: 'Test User',
                },
            };
            makePostRequest.mockResolvedValueOnce(mockData);

            const result = await authenticate(mockEmail, mockPassword);

            expect(createCommonHeaders).toHaveBeenCalledWith(undefined);
            expect(makePostRequest).toHaveBeenCalledWith(
                SIGNUP_URL,
                expect.objectContaining({
                    'x-token': undefined,
                    'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
                    'content-length': expect.any(String),
                }),
                `login=${encodeURIComponent(mockEmail)}&password=${mockPassword}`,
            );

            expect(result).toEqual(mockData);
            expect(logger.withCategory).toHaveBeenCalledWith('authentication');
            expect(mockInfoFn).toHaveBeenCalledWith('Starting authentication...', null);
            expect(mockSuccessFn).toHaveBeenCalledWith('Authentication successful', null, null);
        });

        test('should encode email in request data', async () => {
            const emailWithSpecialChars = 'test+user@example.com';
            makePostRequest.mockResolvedValueOnce({ token: 'test-token' });

            await authenticate(emailWithSpecialChars, mockPassword);

            expect(makePostRequest).toHaveBeenCalledWith(
                SIGNUP_URL,
                expect.any(Object),
                `login=${encodeURIComponent(emailWithSpecialChars)}&password=${mockPassword}`,
            );
        });

        test('should include correct content-length header', async () => {
            makePostRequest.mockResolvedValueOnce({ token: 'test-token' });

            await authenticate(mockEmail, mockPassword);

            const expectedData = `login=${encodeURIComponent(mockEmail)}&password=${mockPassword}`;
            expect(makePostRequest).toHaveBeenCalledWith(
                SIGNUP_URL,
                expect.objectContaining({
                    'content-length': expectedData.length.toString(),
                }),
                expectedData,
            );
        });

        test('should use correct API endpoint', async () => {
            makePostRequest.mockResolvedValueOnce({ token: 'test-token' });

            await authenticate(mockEmail, mockPassword);

            expect(makePostRequest).toHaveBeenCalledWith(SIGNUP_URL, expect.any(Object), expect.any(String));
        });

        test('should return null and log failure when makePostRequest returns null', async () => {
            // makePostRequest returns null on any transport/HTTP failure (it
            // swallows the error internally and logs via the api category).
            makePostRequest.mockResolvedValueOnce(null);

            const result = await authenticate(mockEmail, mockPassword);

            expect(result).toBeNull();
            expect(mockErrorFn).toHaveBeenCalledWith('Authentication failed', null);
            expect(mockSuccessFn).not.toHaveBeenCalled();
        });

        test('should remove x-token from headers for login request', async () => {
            createCommonHeaders.mockReturnValueOnce({
                'x-token': 'some-existing-token',
                'user-agent': 'GuruShots/1.0',
                accept: 'application/json',
            });
            makePostRequest.mockResolvedValueOnce({ token: 'test-token' });

            await authenticate(mockEmail, mockPassword);

            expect(makePostRequest).toHaveBeenCalledWith(
                SIGNUP_URL,
                expect.objectContaining({ 'x-token': undefined }),
                expect.any(String),
            );
        });
    });
});
