/**
 * The renderer-facing settings projection: the token and the API headers never
 * leave main, a renderer learns only whether a token exists, and it cannot write
 * any of those keys.
 */

import { isRendererHiddenKey, toRendererSettings, withoutRendererHiddenKeys } from '../../src/ts/ipc/rendererSettings';
import { invalid } from '../helpers/invalid';

describe('isRendererHiddenKey', () => {
    test.each(['token', 'hasToken', 'apiHeaders'])('hides %s', (key) => {
        expect(isRendererHiddenKey(key)).toBe(true);
    });

    test.each(['theme', 'Token', ''])('leaves %p visible', (key) => {
        expect(isRendererHiddenKey(key)).toBe(false);
    });
});

describe('toRendererSettings', () => {
    test('drops the token and derives hasToken from it', () => {
        const result = toRendererSettings(invalid({ token: 'secret', theme: 'dark' }));
        expect(result).toEqual({ theme: 'dark', hasToken: true });
        expect(result).not.toHaveProperty('token');
    });

    test('drops the API headers, which a renderer neither reads nor writes', () => {
        const result = toRendererSettings(invalid({ token: '', theme: 'dark', apiHeaders: { 'x-key': 'v' } }));
        expect(result).toEqual({ theme: 'dark', hasToken: false });
        expect(result).not.toHaveProperty('apiHeaders');
    });

    test.each([{ token: '' }, {}, { token: 5 }])('reports hasToken false for %p', (stored) => {
        expect(toRendererSettings(invalid(stored))).toEqual({ hasToken: false });
    });
});

describe('withoutRendererHiddenKeys', () => {
    test('removes token, hasToken and apiHeaders, keeping every other key', () => {
        const payload = { token: 'planted', hasToken: true, apiHeaders: { a: 'b' }, theme: 'dark', mock: false };
        expect(withoutRendererHiddenKeys(payload)).toEqual({ theme: 'dark', mock: false });
    });

    test('returns a copy and leaves the payload untouched', () => {
        const payload = { token: 'planted', theme: 'dark' };
        const result = withoutRendererHiddenKeys(payload);
        expect(result).not.toBe(payload);
        expect(payload).toEqual({ token: 'planted', theme: 'dark' });
    });

    test('an object holding only hidden keys yields an empty object', () => {
        expect(withoutRendererHiddenKeys({ token: 'x', hasToken: false })).toEqual({});
    });
});
