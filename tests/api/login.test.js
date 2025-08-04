/**
 * Tests for login.js
 *
 * Tests the authentication functionality.
 */

const axios = require('axios');
const {authenticate} = require('../../src/js/api/login');

// Mock the api-client module
jest.mock('../../src/js/api/api-client', () => ({
    createCommonHeaders: jest.fn((token) => ({
        'x-token': token || 'mock-token',
        'user-agent': 'GuruShots/1.0 (iPhone; iOS 16.0; en_US)',
        'accept': 'application/json',
    })),
    FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded; charset=utf-8'
}));

// Create shared mock functions to track calls across categories
const mockInfoFn = jest.fn();
const mockErrorFn = jest.fn();
const mockSuccessFn = jest.fn();
const mockWarningFn = jest.fn();
const mockDebugFn = jest.fn();
const mockApiFn = jest.fn();
const mockApiRequestFn = jest.fn();

// Mock logger
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
    const {createCommonHeaders} = require('../../src/js/api/api-client');
    const logger = require('../../src/js/logger');

    beforeEach(() => {
        jest.clearAllMocks();
        axios.mockClear();
        mockInfoFn.mockClear();
        mockErrorFn.mockClear();
        mockSuccessFn.mockClear();
        mockWarningFn.mockClear();
        mockDebugFn.mockClear();
    });

    describe('authenticate', () => {
        test('should authenticate successfully with valid credentials', async () => {
            const mockResponse = {
                status: 200,
                data: {
                    token: 'auth-token-123',
                    user: {
                        id: '12345',
                        email: mockEmail,
                        name: 'Test User'
                    }
                }
            };

            axios.mockResolvedValueOnce(mockResponse);

            const result = await authenticate(mockEmail, mockPassword);

            expect(createCommonHeaders).toHaveBeenCalledWith(undefined);
            expect(axios).toHaveBeenCalledWith({
                method: 'post',
                url: 'https://api.gurushots.com/rest_mobile/signup',
                headers: expect.objectContaining({
                    'x-token': undefined,
                    'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
                    'content-length': expect.any(String),
                }),
                data: `login=${encodeURIComponent(mockEmail)}&password=${mockPassword}`,
                timeout: 5000,
            });

            expect(result).toEqual(mockResponse.data);
            expect(mockInfoFn).toHaveBeenCalledWith('Starting authentication...', null);
            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(mockApiRequestFn).toHaveBeenCalledWith('POST', 'https://api.gurushots.com/rest_mobile/signup');
            expect(mockApiFn).toHaveBeenCalledWith('API Response', {
                method: 'POST',
                url: 'https://api.gurushots.com/rest_mobile/signup',
                status: 200,
                duration: expect.any(Number),
                responseData: mockResponse.data
            });
            expect(mockSuccessFn).toHaveBeenCalledWith('Authentication successful', null, null);
        });

        test('should encode email in request data', async () => {
            const emailWithSpecialChars = 'test+user@example.com';
            const mockResponse = {
                status: 200,
                data: {token: 'test-token'}
            };

            axios.mockResolvedValueOnce(mockResponse);

            await authenticate(emailWithSpecialChars, mockPassword);

            expect(axios).toHaveBeenCalledWith(expect.objectContaining({
                data: `login=${encodeURIComponent(emailWithSpecialChars)}&password=${mockPassword}`,
            }));
            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(mockApiRequestFn).toHaveBeenCalledWith('POST', 'https://api.gurushots.com/rest_mobile/signup');
            expect(mockApiFn).toHaveBeenCalledWith('API Response', {
                method: 'POST',
                url: 'https://api.gurushots.com/rest_mobile/signup',
                status: 200,
                duration: expect.any(Number),
                responseData: {token: 'test-token'}
            });
        });

        test('should include correct content-length header', async () => {
            const mockResponse = {
                status: 200,
                data: {token: 'test-token'}
            };

            axios.mockResolvedValueOnce(mockResponse);

            await authenticate(mockEmail, mockPassword);

            const expectedData = `login=${encodeURIComponent(mockEmail)}&password=${mockPassword}`;
            expect(axios).toHaveBeenCalledWith(expect.objectContaining({
                headers: expect.objectContaining({
                    'content-length': expectedData.length.toString(),
                }),
            }));
            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(mockApiRequestFn).toHaveBeenCalledWith('POST', 'https://api.gurushots.com/rest_mobile/signup');
            expect(mockApiFn).toHaveBeenCalledWith('API Response', {
                method: 'POST',
                url: 'https://api.gurushots.com/rest_mobile/signup',
                status: 200,
                duration: expect.any(Number),
                responseData: {token: 'test-token'}
            });
        });

        test('should use 5 second timeout', async () => {
            const mockResponse = {
                status: 200,
                data: {token: 'test-token'}
            };

            axios.mockResolvedValueOnce(mockResponse);

            await authenticate(mockEmail, mockPassword);

            expect(axios).toHaveBeenCalledWith(expect.objectContaining({
                timeout: 5000,
            }));
        });

        test('should use correct API endpoint', async () => {
            const mockResponse = {
                status: 200,
                data: {token: 'test-token'}
            };

            axios.mockResolvedValueOnce(mockResponse);

            await authenticate(mockEmail, mockPassword);

            expect(axios).toHaveBeenCalledWith(expect.objectContaining({
                url: 'https://api.gurushots.com/rest_mobile/signup',
            }));
        });

        test('should return null on authentication error', async () => {
            const mockError = new Error('Invalid credentials');
            axios.mockRejectedValueOnce(mockError);

            const result = await authenticate(mockEmail, mockPassword);

            expect(result).toBeNull();
            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(mockApiRequestFn).toHaveBeenCalledWith('POST', 'https://api.gurushots.com/rest_mobile/signup');
            expect(mockApiFn).toHaveBeenCalledWith('API Error Response', {
                method: 'POST',
                url: 'https://api.gurushots.com/rest_mobile/signup',
                status: 'NO_RESPONSE',
                duration: expect.any(Number),
                error: 'Invalid credentials',
                responseData: null
            });
            expect(mockErrorFn).toHaveBeenCalledWith('Authentication error:', 'Invalid credentials');
        });

        test('should return null on network error', async () => {
            const mockError = new Error('Network timeout');
            axios.mockRejectedValueOnce(mockError);

            const result = await authenticate(mockEmail, mockPassword);

            expect(result).toBeNull();
            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(mockApiRequestFn).toHaveBeenCalledWith('POST', 'https://api.gurushots.com/rest_mobile/signup');
            expect(mockApiFn).toHaveBeenCalledWith('API Error Response', {
                method: 'POST',
                url: 'https://api.gurushots.com/rest_mobile/signup',
                status: 'NO_RESPONSE',
                duration: expect.any(Number),
                error: 'Network timeout',
                responseData: null
            });
            expect(mockErrorFn).toHaveBeenCalledWith('Authentication error:', 'Network timeout');
        });

        test('should handle error without message', async () => {
            const mockError = {code: 'NETWORK_ERROR'};
            axios.mockRejectedValueOnce(mockError);

            const result = await authenticate(mockEmail, mockPassword);

            expect(result).toBeNull();
            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(mockApiRequestFn).toHaveBeenCalledWith('POST', 'https://api.gurushots.com/rest_mobile/signup');
            expect(mockApiFn).toHaveBeenCalledWith('API Error Response', {
                method: 'POST',
                url: 'https://api.gurushots.com/rest_mobile/signup',
                status: 'NO_RESPONSE',
                duration: expect.any(Number),
                error: undefined,
                responseData: null
            });
            expect(mockErrorFn).toHaveBeenCalledWith('Authentication error:', mockError);
        });

        test('should handle axios error with response', async () => {
            const mockError = new Error('Request failed');
            mockError.response = {
                status: 401,
                data: {error: 'Unauthorized'}
            };
            axios.mockRejectedValueOnce(mockError);

            const result = await authenticate(mockEmail, mockPassword);

            expect(result).toBeNull();
            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(mockApiRequestFn).toHaveBeenCalledWith('POST', 'https://api.gurushots.com/rest_mobile/signup');
            expect(mockApiFn).toHaveBeenCalledWith('API Error Response', {
                method: 'POST',
                url: 'https://api.gurushots.com/rest_mobile/signup',
                status: 401,
                duration: expect.any(Number),
                error: 'Request failed',
                responseData: {error: 'Unauthorized'}
            });
            expect(mockErrorFn).toHaveBeenCalledWith('Authentication error:', 'Request failed');
        });

        test('should remove x-token from headers for login request', async () => {
            const mockResponse = {
                status: 200,
                data: {token: 'test-token'}
            };

            // Mock createCommonHeaders to return headers with x-token
            createCommonHeaders.mockReturnValueOnce({
                'x-token': 'some-existing-token',
                'user-agent': 'GuruShots/1.0',
                'accept': 'application/json',
            });

            axios.mockResolvedValueOnce(mockResponse);

            await authenticate(mockEmail, mockPassword);

            expect(axios).toHaveBeenCalledWith(expect.objectContaining({
                headers: expect.objectContaining({
                    'x-token': undefined,
                }),
            }));
        });

        test('should use POST method', async () => {
            const mockResponse = {
                data: {token: 'test-token'}
            };

            axios.mockResolvedValueOnce(mockResponse);

            await authenticate(mockEmail, mockPassword);

            expect(axios).toHaveBeenCalledWith(expect.objectContaining({
                method: 'post',
            }));
        });

        test('should handle empty response data', async () => {
            const mockResponse = {
                status: 200,
                data: null
            };

            axios.mockResolvedValueOnce(mockResponse);

            const result = await authenticate(mockEmail, mockPassword);

            expect(result).toBeNull();
            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(mockApiRequestFn).toHaveBeenCalledWith('POST', 'https://api.gurushots.com/rest_mobile/signup');
            expect(mockApiFn).toHaveBeenCalledWith('API Response', {
                method: 'POST',
                url: 'https://api.gurushots.com/rest_mobile/signup',
                status: 200,
                duration: expect.any(Number),
                responseData: null
            });
            expect(mockSuccessFn).toHaveBeenCalledWith('Authentication successful', null, null);
        });

        test('should handle response without data field', async () => {
            const mockResponse = {
                status: 200
            };

            axios.mockResolvedValueOnce(mockResponse);

            const result = await authenticate(mockEmail, mockPassword);

            expect(result).toBeUndefined();
            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(mockApiRequestFn).toHaveBeenCalledWith('POST', 'https://api.gurushots.com/rest_mobile/signup');
            expect(mockApiFn).toHaveBeenCalledWith('API Response', {
                method: 'POST',
                url: 'https://api.gurushots.com/rest_mobile/signup',
                status: 200,
                duration: expect.any(Number),
                responseData: undefined
            });
            expect(mockSuccessFn).toHaveBeenCalledWith('Authentication successful', null, null);
        });
    });
});