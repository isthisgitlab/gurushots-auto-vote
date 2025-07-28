/**
 * Tests for login.js
 * 
 * Tests the authentication functionality.
 */

const axios = require('axios');
const { authenticate } = require('../../src/js/api/login');

// Mock the api-client module
jest.mock('../../src/js/api/api-client', () => ({
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

describe('login', () => {
  const mockEmail = 'test@example.com';
  const mockPassword = 'testpassword123';
  const { createCommonHeaders } = require('../../src/js/api/api-client');

  beforeEach(() => {
    jest.clearAllMocks();
    axios.mockClear();
  });

  describe('authenticate', () => {
    test('should authenticate successfully with valid credentials', async () => {
      const mockResponse = {
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
      expect(console.log).toHaveBeenCalledWith('Starting authentication...');
      expect(console.log).toHaveBeenCalledWith('Authentication successful');
    });

    test('should encode email in request data', async () => {
      const emailWithSpecialChars = 'test+user@example.com';
      const mockResponse = {
        data: { token: 'test-token' }
      };

      axios.mockResolvedValueOnce(mockResponse);

      await authenticate(emailWithSpecialChars, mockPassword);

      expect(axios).toHaveBeenCalledWith(expect.objectContaining({
        data: `login=${encodeURIComponent(emailWithSpecialChars)}&password=${mockPassword}`,
      }));
    });

    test('should include correct content-length header', async () => {
      const mockResponse = {
        data: { token: 'test-token' }
      };

      axios.mockResolvedValueOnce(mockResponse);

      await authenticate(mockEmail, mockPassword);

      const expectedData = `login=${encodeURIComponent(mockEmail)}&password=${mockPassword}`;
      expect(axios).toHaveBeenCalledWith(expect.objectContaining({
        headers: expect.objectContaining({
          'content-length': expectedData.length.toString(),
        }),
      }));
    });

    test('should use 5 second timeout', async () => {
      const mockResponse = {
        data: { token: 'test-token' }
      };

      axios.mockResolvedValueOnce(mockResponse);

      await authenticate(mockEmail, mockPassword);

      expect(axios).toHaveBeenCalledWith(expect.objectContaining({
        timeout: 5000,
      }));
    });

    test('should use correct API endpoint', async () => {
      const mockResponse = {
        data: { token: 'test-token' }
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
      expect(console.error).toHaveBeenCalledWith('Authentication error:', 'Invalid credentials');
    });

    test('should return null on network error', async () => {
      const mockError = new Error('Network timeout');
      axios.mockRejectedValueOnce(mockError);

      const result = await authenticate(mockEmail, mockPassword);

      expect(result).toBeNull();
      expect(console.error).toHaveBeenCalledWith('Authentication error:', 'Network timeout');
    });

    test('should handle error without message', async () => {
      const mockError = { code: 'NETWORK_ERROR' };
      axios.mockRejectedValueOnce(mockError);

      const result = await authenticate(mockEmail, mockPassword);

      expect(result).toBeNull();
      expect(console.error).toHaveBeenCalledWith('Authentication error:', mockError);
    });

    test('should handle axios error with response', async () => {
      const mockError = new Error('Request failed');
      mockError.response = {
        status: 401,
        data: { error: 'Unauthorized' }
      };
      axios.mockRejectedValueOnce(mockError);

      const result = await authenticate(mockEmail, mockPassword);

      expect(result).toBeNull();
      expect(console.error).toHaveBeenCalledWith('Authentication error:', 'Request failed');
    });

    test('should remove x-token from headers for login request', async () => {
      const mockResponse = {
        data: { token: 'test-token' }
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
        data: { token: 'test-token' }
      };

      axios.mockResolvedValueOnce(mockResponse);

      await authenticate(mockEmail, mockPassword);

      expect(axios).toHaveBeenCalledWith(expect.objectContaining({
        method: 'post',
      }));
    });

    test('should handle empty response data', async () => {
      const mockResponse = {
        data: null
      };

      axios.mockResolvedValueOnce(mockResponse);

      const result = await authenticate(mockEmail, mockPassword);

      expect(result).toBeNull();
      expect(console.log).toHaveBeenCalledWith('Authentication successful');
    });

    test('should handle response without data field', async () => {
      const mockResponse = {};

      axios.mockResolvedValueOnce(mockResponse);

      const result = await authenticate(mockEmail, mockPassword);

      expect(result).toBeUndefined();
      expect(console.log).toHaveBeenCalledWith('Authentication successful');
    });
  });
});