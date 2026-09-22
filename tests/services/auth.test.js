/**
 * Tests for the shared auth normalizer (services/auth.js extractAuthResult).
 * This is the single place that knows the GuruShots auth wire shape — both
 * BaseMiddleware._login (CLI + GUI) and the authenticate IPC handler depend on
 * it, so these cases guard the cross-platform login contract, especially the
 * alternate token keys a live response can use.
 */

jest.mock('../../src/js/settings', () => ({ loadSettings: jest.fn() }));
jest.mock('../../src/js/logger', () => ({
    withCategory: jest.fn(() => ({ info: jest.fn(), warning: jest.fn(), error: jest.fn() })),
}));

const settings = require('../../src/js/settings');
const logger = require('../../src/js/logger');
const { extractAuthResult, requireAuthToken } = require('../../src/js/services/auth');

describe('extractAuthResult', () => {
    test('null / undefined response → no-response failure', () => {
        expect(extractAuthResult(null)).toEqual({
            ok: false,
            token: null,
            error: 'Authentication failed - no response from server',
        });
        expect(extractAuthResult(undefined).ok).toBe(false);
    });

    test('accepts a primary `token`', () => {
        expect(extractAuthResult({ token: 'abc' })).toEqual({ ok: true, token: 'abc', error: null });
    });

    test('accepts `access_token` and `auth_token` fallbacks', () => {
        expect(extractAuthResult({ access_token: 'a1' })).toEqual({ ok: true, token: 'a1', error: null });
        expect(extractAuthResult({ auth_token: 'a2' })).toEqual({ ok: true, token: 'a2', error: null });
    });

    test('success/status flags without a token still fail (nothing to persist)', () => {
        expect(extractAuthResult({ success: true }).ok).toBe(false);
        expect(extractAuthResult({ status: 'success' }).ok).toBe(false);
    });

    test('a blank / whitespace-only token is rejected, not persisted', () => {
        expect(extractAuthResult({ token: '' }).ok).toBe(false);
        expect(extractAuthResult({ token: '   ' })).toEqual({
            ok: false,
            token: null,
            error: 'Authentication failed - invalid response from server',
        });
    });

    test('surfaces the server-provided error/message on failure', () => {
        expect(extractAuthResult({ error: 'bad creds' }).error).toBe('bad creds');
        expect(extractAuthResult({ message: 'nope' }).error).toBe('nope');
        expect(extractAuthResult({}).error).toBe('Authentication failed - invalid response from server');
    });
});

describe('requireAuthToken', () => {
    test('returns the token and the loaded settings when logged in', () => {
        const userSettings = { token: 'tok', language: 'en' };
        settings.loadSettings.mockReturnValue(userSettings);
        expect(requireAuthToken('boost')).toEqual({ ok: true, token: 'tok', settings: userSettings });
    });

    test('returns a ready-to-send early-return response and warns when there is no token', () => {
        const warning = jest.fn();
        logger.withCategory.mockReturnValueOnce({ warning });
        settings.loadSettings.mockReturnValue({ token: '' });
        expect(requireAuthToken('turbo apply')).toEqual({
            ok: false,
            response: { success: false, error: 'No authentication token found' },
        });
        expect(logger.withCategory).toHaveBeenCalledWith('authentication');
        expect(warning).toHaveBeenCalledWith('❌ No token found for turbo apply', null);
    });
});
