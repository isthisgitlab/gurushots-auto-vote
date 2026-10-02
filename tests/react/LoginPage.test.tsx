/**
 * Login page (pages/Login.tsx) — hydrates theme / stay-logged-in / username
 * from settings and mock mode from the environment, persists toggle changes,
 * and on a successful auth saves the token (+ username when remembered) and
 * transitions via window.api.login(). Also covers the module-load auto-mount,
 * which the Capacitor entry suppresses with __capacitorBootstrap.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { invalid } from '../helpers/invalid';
import { pickOption } from './helpers/test-utils';

import type { RendererGlobals } from '../../src/ts/types/capacitor';
import type { WindowApi } from '../../src/ts/types/ipc';
import type * as LoginModule from '@/pages/Login';

const API_METHODS = ['getSettings', 'getEnvironmentInfo', 'authenticate', 'setSetting', 'login'] as const;

let LoginPage: typeof LoginModule.default;
let mountLogin: typeof LoginModule.mountLogin;

describe('Login page', () => {
    let originals: Record<string, unknown>;

    beforeAll(async () => {
        // Import with no #root so the module-load mount is a no-op here.
        ({ default: LoginPage, mountLogin } = await import('@/pages/Login'));
        await Promise.resolve();
    });

    beforeEach(() => {
        originals = Object.fromEntries(API_METHODS.map((m) => [m, window.api[m]]));
        window.api.getSettings = jest.fn().mockResolvedValue({});
        window.api.getEnvironmentInfo = jest.fn().mockResolvedValue({ defaultMock: false });
        window.api.authenticate = jest.fn().mockResolvedValue({ success: true });
        window.api.setSetting = jest.fn().mockResolvedValue(undefined);
        (window.api as { login: WindowApi['login'] }).login = jest.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
        Object.assign(window.api, originals);
        document.documentElement.removeAttribute('data-theme');
        document.body.innerHTML = '';
        delete (globalThis as RendererGlobals).__capacitorBootstrap;
    });

    const renderReady = async () => {
        const utils = render(<LoginPage />);
        await waitFor(() => expect(screen.getByText('login.heading')).toBeTruthy());
        return utils;
    };

    const submit = (username: string, password: string) => {
        fireEvent.input(document.getElementById('username')!, { target: { value: username } });
        fireEvent.input(document.getElementById('password')!, { target: { value: password } });
        fireEvent.submit(document.querySelector('form')!);
    };

    const checkboxes = () => document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const themeSelect = () => document.getElementById('login-theme') as HTMLSelectElement;

    test('shows the loader, then defaults (light, not remembered, live mode)', async () => {
        render(<LoginPage />);
        expect(screen.getByText('common.loading')).toBeTruthy();
        await waitFor(() => expect(screen.getByText('login.heading')).toBeTruthy());
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        expect(themeSelect().value).toBe('light');
        const [stay, mock] = checkboxes();
        expect([stay.checked, mock.checked]).toEqual([false, false]);
        expect((document.getElementById('username') as HTMLInputElement).value).toBe('');
        expect(screen.getByText('login.loadingModeInfo')).toBeTruthy();
    });

    test('hydrates from settings and the environment default', async () => {
        jest.mocked(window.api.getSettings).mockResolvedValue(
            invalid({ theme: 'dracula', stayLoggedIn: true, lastUsername: 'bob' }),
        );
        jest.mocked(window.api.getEnvironmentInfo).mockResolvedValue(invalid({ defaultMock: true }));
        await renderReady();
        await waitFor(() => expect((document.getElementById('username') as HTMLInputElement).value).toBe('bob'));
        // The theme lands via a passive effect, which can trail the username commit.
        await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dracula'));
        expect(themeSelect().value).toBe('dracula');
        const [stay, mock] = checkboxes();
        expect([stay.checked, mock.checked]).toEqual([true, true]);
        expect(screen.getByText('login.mockModeInfo')).toBeTruthy();
    });

    test('remembered without a saved username leaves the field empty', async () => {
        jest.mocked(window.api.getSettings).mockResolvedValue(invalid({ stayLoggedIn: true }));
        await renderReady();
        expect(checkboxes()[0].checked).toBe(true);
        expect((document.getElementById('username') as HTMLInputElement).value).toBe('');
    });

    test('env info failure keeps live mode', async () => {
        jest.mocked(window.api.getEnvironmentInfo).mockRejectedValue(new Error('no env'));
        await renderReady();
        expect(checkboxes()[1].checked).toBe(false);
    });

    test('env info without defaultMock keeps live mode', async () => {
        jest.mocked(window.api.getEnvironmentInfo).mockResolvedValue(invalid({}));
        await renderReady();
        expect(checkboxes()[1].checked).toBe(false);
    });

    test('the theme picker and toggles persist theme, stay-logged-in (clearing the username when off) and mock', async () => {
        await renderReady();
        const [stay, mock] = checkboxes();

        pickOption(themeSelect(), 'synthwave');
        await waitFor(() => expect(window.api.setSetting).toHaveBeenCalledWith('theme', 'synthwave'));
        expect(document.documentElement.getAttribute('data-theme')).toBe('synthwave');

        fireEvent.click(stay);
        await waitFor(() => expect(window.api.setSetting).toHaveBeenCalledWith('stayLoggedIn', true));
        expect(window.api.setSetting).not.toHaveBeenCalledWith('lastUsername', '');
        await waitFor(() => expect(checkboxes()[0].checked).toBe(true));

        fireEvent.click(checkboxes()[0]);
        await waitFor(() => expect(window.api.setSetting).toHaveBeenCalledWith('lastUsername', ''));
        expect(window.api.setSetting).toHaveBeenCalledWith('stayLoggedIn', false);

        fireEvent.click(mock);
        await waitFor(() => expect(window.api.setSetting).toHaveBeenCalledWith('mock', true));
        expect(screen.getByText('login.mockModeInfo')).toBeTruthy();
    });

    test('successful login saves mock mode (never the token) and transitions (username not remembered)', async () => {
        await renderReady();
        submit('alice', 'pw');
        await waitFor(() => expect(window.api.login).toHaveBeenCalledTimes(1));
        expect(window.api.authenticate).toHaveBeenCalledWith('alice', 'pw', false);
        expect(window.api.setSetting).not.toHaveBeenCalledWith('token', expect.anything());
        expect(window.api.setSetting).toHaveBeenCalledWith('mock', false);
        expect(window.api.setSetting).not.toHaveBeenCalledWith('lastUsername', 'alice');
    });

    test('successful login remembers the username when stay-logged-in is on', async () => {
        jest.mocked(window.api.getSettings).mockResolvedValue(invalid({ stayLoggedIn: true }));
        await renderReady();
        submit('alice', 'pw');
        await waitFor(() => expect(window.api.login).toHaveBeenCalledTimes(1));
        expect(window.api.setSetting).toHaveBeenCalledWith('lastUsername', 'alice');
    });

    test('failed auth shows the error and does not transition', async () => {
        jest.mocked(window.api.authenticate).mockResolvedValue({ success: false, error: 'Bad credentials' });
        await renderReady();
        submit('alice', 'wrong');
        await waitFor(() => expect(screen.getByText('Bad credentials')).toBeTruthy());
        expect(window.api.setSetting).not.toHaveBeenCalledWith('token', expect.anything());
        expect(window.api.login).not.toHaveBeenCalled();
    });

    test('mountLogin renders into #root and is a no-op without it', async () => {
        mountLogin();
        expect(document.body.textContent).toBe('');

        const root = document.createElement('div');
        root.id = 'root';
        document.body.appendChild(root);
        mountLogin();
        await waitFor(() => expect(root.textContent).toContain('login.heading'));
    });

    test('module load auto-mounts unless the Capacitor bootstrap flag is set', async () => {
        const root = document.createElement('div');
        root.id = 'root';
        document.body.appendChild(root);

        (globalThis as RendererGlobals).__capacitorBootstrap = true;
        jest.isolateModules(() => {
            require('@/pages/Login');
        });
        await Promise.resolve();
        expect(root.textContent).toBe('');

        delete (globalThis as RendererGlobals).__capacitorBootstrap;
        jest.isolateModules(() => {
            require('@/pages/Login');
        });
        await Promise.resolve();
        expect(root.textContent).toBe('common.loading');
    });
});
