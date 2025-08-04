/**
 * Tests for api-client.js
 *
 * Tests the core HTTP client functionality and common headers for API requests.
 */

const axios = require('axios');
const {makePostRequest, createCommonHeaders, FORM_CONTENT_TYPE} = require('../../src/js/api/api-client');

// Mock the randomizer module
jest.mock('../../src/js/api/randomizer', () => ({
    generateRandomHeaders: jest.fn((token) => ({
        'x-token': token || 'mock-token',
        'user-agent': 'GuruShots/1.0 (iPhone; iOS 16.0; en_US)',
        'accept': 'application/json',
        'accept-language': 'en-US',
        'connection': 'keep-alive',
    }))
}));

// Mock the logger module
jest.mock('../../src/js/logger', () => {
    const mockApiFn = jest.fn();
    const mockApiRequestFn = jest.fn();
    
    return {
        api: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        apiRequest: jest.fn(),
        apiResponse: jest.fn(),
        isDevMode: jest.fn(() => false),
        startOperation: jest.fn(),
        endOperation: jest.fn(),
        withCategory: jest.fn(() => ({
            info: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
            success: jest.fn(),
            warning: jest.fn(),
            api: mockApiFn,
            apiRequest: mockApiRequestFn,
            startOperation: jest.fn(),
            endOperation: jest.fn(),
            progress: jest.fn(),
        })),
        // Export the mock functions for testing
        __mockApiFn: mockApiFn,
        __mockApiRequestFn: mockApiRequestFn,
    };
});

describe('api-client', () => {
    const mockToken = 'test-token-123';
    const mockUrl = 'https://api.gurushots.com/test';
    const mockData = 'test=data';
    const logger = require('../../src/js/logger');

    beforeEach(() => {
        jest.clearAllMocks();
        // Reset axios mock
        axios.mockClear();
    });

    describe('FORM_CONTENT_TYPE', () => {
        test('should export correct content type', () => {
            expect(FORM_CONTENT_TYPE).toBe('application/x-www-form-urlencoded; charset=utf-8');
        });
    });

    describe('createCommonHeaders', () => {
        test('should create headers with token', () => {
            const headers = createCommonHeaders(mockToken);

            expect(headers).toEqual(expect.objectContaining({
                'x-token': mockToken,
                'user-agent': expect.stringContaining('GuruShots'),
                'accept': 'application/json',
                'accept-language': 'en-US',
                'connection': 'keep-alive',
            }));
        });

        test('should create headers without token', () => {
            const headers = createCommonHeaders();

            expect(headers).toEqual(expect.objectContaining({
                'x-token': 'mock-token',
                'user-agent': expect.stringContaining('GuruShots'),
                'accept': 'application/json',
                'accept-language': 'en-US',
                'connection': 'keep-alive',
            }));
        });
    });

    describe('makePostRequest', () => {
        test('should make successful POST request', async () => {
            const mockResponse = {
                status: 200,
                headers: {'content-type': 'application/json'},
                data: {success: true, message: 'Request successful'}
            };

            axios.mockResolvedValueOnce(mockResponse);

            const headers = createCommonHeaders(mockToken);
            const result = await makePostRequest(mockUrl, headers, mockData);

            expect(axios).toHaveBeenCalledWith({
                method: 'post',
                url: mockUrl,
                headers: headers,
                data: mockData,
                timeout: 30000,
            });

            expect(result).toEqual(mockResponse.data);
        });

        test('should handle request with empty data', async () => {
            const mockResponse = {
                status: 200,
                headers: {'content-type': 'application/json'},
                data: {success: true}
            };

            axios.mockResolvedValueOnce(mockResponse);

            const headers = createCommonHeaders(mockToken);
            const result = await makePostRequest(mockUrl, headers);

            expect(axios).toHaveBeenCalledWith({
                method: 'post',
                url: mockUrl,
                headers: headers,
                data: '',
                timeout: 30000,
            });

            expect(result).toEqual(mockResponse.data);
        });

        test('should return null on request error', async () => {
            const mockError = new Error('Network error');
            mockError.response = {
                status: 500,
                data: {error: 'Internal server error'},
                headers: {'content-type': 'application/json'}
            };

            axios.mockRejectedValueOnce(mockError);

            const headers = createCommonHeaders(mockToken);
            const result = await makePostRequest(mockUrl, headers, mockData);

            expect(result).toBeNull();
        });

        test('should return null on request error without response', async () => {
            const mockError = new Error('Network timeout');

            axios.mockRejectedValueOnce(mockError);

            const headers = createCommonHeaders(mockToken);
            const result = await makePostRequest(mockUrl, headers, mockData);

            expect(result).toBeNull();
        });

        test('should use 30 second timeout', async () => {
            const mockResponse = {
                status: 200,
                headers: {},
                data: {success: true}
            };

            axios.mockResolvedValueOnce(mockResponse);

            const headers = createCommonHeaders(mockToken);
            await makePostRequest(mockUrl, headers, mockData);

            expect(axios).toHaveBeenCalledWith(expect.objectContaining({
                timeout: 30000,
            }));
        });

        test('should log API requests and responses', async () => {
            const logger = require('../../src/js/logger');
            const mockResponse = {
                status: 200,
                headers: {'content-type': 'application/json'},
                data: {success: true}
            };

            axios.mockResolvedValueOnce(mockResponse);

            const headers = createCommonHeaders(mockToken);
            await makePostRequest(mockUrl, headers, mockData);

            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockApiRequestFn).toHaveBeenCalledWith('POST', mockUrl);
            expect(logger.__mockApiFn).toHaveBeenCalledWith('API Response', {
                method: 'POST',
                url: mockUrl,
                status: mockResponse.status,
                duration: expect.any(Number),
                responseData: mockResponse.data
            });
        });

        test('should log API errors', async () => {
            const logger = require('../../src/js/logger');
            const mockError = new Error('API error');
            mockError.response = {
                status: 400,
                data: {error: 'Bad request'},
                headers: {'content-type': 'application/json'}
            };

            axios.mockRejectedValueOnce(mockError);

            const headers = createCommonHeaders(mockToken);
            await makePostRequest(mockUrl, headers, mockData);

            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockApiFn).toHaveBeenCalledWith('API Error Response', {
                method: 'POST',
                url: mockUrl,
                status: 400,
                duration: expect.any(Number),
                error: mockError.message,
                responseData: {error: 'Bad request'},
                timeout: false,
            });
        });

        test('should log API errors without response', async () => {
            const logger = require('../../src/js/logger');
            const mockError = new Error('Network timeout');

            axios.mockRejectedValueOnce(mockError);

            const headers = createCommonHeaders(mockToken);
            await makePostRequest(mockUrl, headers, mockData);

            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockApiFn).toHaveBeenCalledWith('API Error Response', {
                method: 'POST',
                url: mockUrl,
                status: 'NO_RESPONSE',
                duration: expect.any(Number),
                error: mockError.message,
                responseData: null,
                timeout: false,
            });
        });

        test('should log API response with full data', async () => {
            const logger = require('../../src/js/logger');

            const mockResponse = {
                status: 200,
                headers: {'content-type': 'application/json'},
                data: {success: true, message: 'Request successful'}
            };

            axios.mockResolvedValueOnce(mockResponse);

            const headers = createCommonHeaders(mockToken);
            await makePostRequest(mockUrl, headers, mockData);

            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockApiFn).toHaveBeenCalledWith('API Response', {
                method: 'POST',
                url: mockUrl,
                status: mockResponse.status,
                duration: expect.any(Number),
                responseData: mockResponse.data
            });
        });
    });
});