/**
 * The renderer-facing settings projection: the whole `auth` block (the token, the API headers, the last user name and
 * the chosen-photos account) never leaves main, a renderer learns only whether a token exists, and it cannot write
 * any of those keys.
 */

import {
    isRendererHiddenKey,
    isRendererReadOnlyKey,
    toRendererSettings,
    withoutRendererHiddenKeys,
} from '../../src/ts/ipc/rendererSettings';
import { getDefaultSettings } from '../../src/ts/settings/defaults';
import { invalid } from '../helpers/invalid';

import type { ConfigV2 } from '../../src/ts/types/config';

const config = (auth: Partial<ConfigV2['auth']> = {}, rest: Partial<ConfigV2> = {}): ConfigV2 => ({
    ...getDefaultSettings(),
    ...rest,
    auth: { ...getDefaultSettings().auth, ...auth },
});

describe('isRendererHiddenKey', () => {
    test.each(['auth', 'token', 'hasToken', 'apiHeaders'])('hides %s', (key) => {
        expect(isRendererHiddenKey(key)).toBe(true);
    });

    test.each(['theme', 'Token', '', 'lastUsername', 'chosenPhotosMemberId'])('leaves %p visible', (key) => {
        expect(isRendererHiddenKey(key)).toBe(false);
    });
});

describe('isRendererReadOnlyKey', () => {
    test.each(['lastUsername', 'chosenPhotosMemberId'])('%s may be read by the renderer, never written', (key) => {
        expect(isRendererReadOnlyKey(key)).toBe(true);
    });

    test.each(['theme', 'token', 'auth', ''])('%p is not one of them', (key) => {
        expect(isRendererReadOnlyKey(key)).toBe(false);
    });
});

describe('toRendererSettings', () => {
    test('drops the whole auth block and derives hasToken from the token', () => {
        const result = toRendererSettings(
            config(
                { token: 'secret', apiHeaders: { 'x-key': 'v' }, lastUsername: 'me', chosenPhotosMemberId: 'm1' },
                { app: { ...getDefaultSettings().app, theme: 'dark' } },
            ),
        );
        expect(result.hasToken).toBe(true);
        expect(result.app.theme).toBe('dark');
        expect(result).not.toHaveProperty('auth');
        expect(JSON.stringify(result)).not.toMatch(/secret|x-key|"me"|m1/);
    });

    test('keeps every other part of the configuration', () => {
        const stored = config(
            { token: 't' },
            {
                defaults: { exposure: 80 },
                profiles: { P: { exposure: 70 } },
                rules: [{ title: 'Macro' }],
                challenges: { '7': { values: { exposure: 60 }, pins: { boost: 'e1' } } },
                imported: { at: 'x', report: { refsBlocked: [] }, acknowledged: false },
            },
        );
        const { auth, ...rest } = stored;
        expect(auth.token).toBe('t');
        expect(toRendererSettings(stored)).toEqual({ ...rest, hasToken: true });
    });

    test.each([[''], [5], [null]])('reports hasToken false for the token %p', (token) => {
        expect(toRendererSettings(config(invalid({ token }))).hasToken).toBe(false);
    });
});

describe('withoutRendererHiddenKeys', () => {
    test('removes the sign-in keys, hasToken and auth, keeping every other key', () => {
        const payload = {
            token: 'planted',
            hasToken: true,
            apiHeaders: { a: 'b' },
            lastUsername: 'me',
            chosenPhotosMemberId: 'm1',
            auth: { token: 'planted' },
            theme: 'dark',
            mock: false,
        };
        expect(withoutRendererHiddenKeys(payload)).toEqual({ theme: 'dark', mock: false });
    });

    test('returns a copy and leaves the payload untouched', () => {
        const payload = { token: 'planted', theme: 'dark' };
        const result = withoutRendererHiddenKeys(payload);
        expect(result).not.toBe(payload);
        expect(payload).toEqual({ token: 'planted', theme: 'dark' });
    });

    test('an object holding only hidden keys yields an empty object', () => {
        expect(withoutRendererHiddenKeys({ token: 'x', hasToken: false, auth: {} })).toEqual({});
    });
});
