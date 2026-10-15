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
import { CURRENT_NOTICE_VERSION } from '../../src/ts/noticeVersion';

import type { RendererGlobals } from '../../src/ts/types/capacitor';
import type { WindowApi } from '../../src/ts/types/ipc';
import type * as LoginModule from '@/pages/Login';

const API_METHODS = ['getSettings', 'getSetting', 'getEnvironmentInfo', 'authenticate', 'setSetting', 'login'] as const;

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
        window.api.getSettings = jest.fn().mockResolvedValue({ app: {} });
        window.api.getSetting = jest.fn().mockResolvedValue('');
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
        delete (globalThis as RendererGlobals).Capacitor;
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
            invalid({ app: { theme: 'dracula', stayLoggedIn: true } }),
        );
        // The saved user name is part of the sign-in state, which the settings the page is handed leave out.
        jest.mocked(window.api.getSetting).mockImplementation((key) =>
            Promise.resolve(key === 'lastUsername' ? 'bob' : null),
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
        jest.mocked(window.api.getSettings).mockResolvedValue(invalid({ app: { stayLoggedIn: true } }));
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

    test('the theme picker and toggles persist theme, stay-logged-in (the main process clears the username when off) and mock', async () => {
        await renderReady();
        const [stay, mock] = checkboxes();

        pickOption(themeSelect(), 'synthwave');
        await waitFor(() => expect(window.api.setSetting).toHaveBeenCalledWith('theme', 'synthwave'));
        expect(document.documentElement.getAttribute('data-theme')).toBe('synthwave');

        fireEvent.click(stay);
        await waitFor(() => expect(window.api.setSetting).toHaveBeenCalledWith('stayLoggedIn', true));
        await waitFor(() => expect(checkboxes()[0].checked).toBe(true));

        fireEvent.click(checkboxes()[0]);
        await waitFor(() => expect(window.api.setSetting).toHaveBeenCalledWith('stayLoggedIn', false));
        // A renderer cannot write the sign-in state: the main process drops the saved name with this write.
        expect(window.api.setSetting).not.toHaveBeenCalledWith('lastUsername', '');

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

    test('successful login leaves remembering the username to the main process, even when stay-logged-in is on', async () => {
        jest.mocked(window.api.getSettings).mockResolvedValue(invalid({ app: { stayLoggedIn: true } }));
        await renderReady();
        submit('alice', 'pw');
        await waitFor(() => expect(window.api.login).toHaveBeenCalledTimes(1));
        expect(window.api.setSetting).not.toHaveBeenCalledWith('lastUsername', expect.anything());
    });

    test('without a saved username the field stays empty, and a failed read of it too', async () => {
        jest.mocked(window.api.getSettings).mockResolvedValue(invalid({ app: { stayLoggedIn: true } }));
        jest.mocked(window.api.getSetting).mockResolvedValue(5);
        await renderReady();
        expect((document.getElementById('username') as HTMLInputElement).value).toBe('');
    });

    test('failed auth shows a translated, announced error and does not transition', async () => {
        jest.mocked(window.api.authenticate).mockResolvedValue({ success: false, error: 'Bad credentials' });
        await renderReady();
        submit('alice', 'wrong');
        // An unlisted message is never shown raw: the generic login-failed text stands in for it.
        await waitFor(() => expect(screen.getByText('errors.loginFailed')).toBeTruthy());
        expect(screen.getByText('errors.loginFailed').closest('[role="alert"]')).not.toBeNull();
        expect(screen.queryByText('Bad credentials')).toBeNull();
        expect(window.api.setSetting).not.toHaveBeenCalledWith('token', expect.anything());
        expect(window.api.login).not.toHaveBeenCalled();
    });

    test('the unofficial-app notice shows on the login page and acknowledging it persists the version', async () => {
        await renderReady();
        expect(screen.getByRole('dialog', { name: 'notice.title' })).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'notice.acknowledge' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'notice.title' })).toBeNull());
        expect(window.api.setSetting).toHaveBeenCalledWith('noticeAcknowledgedVersion', CURRENT_NOTICE_VERSION);
    });

    test('an acknowledged notice is not shown again', async () => {
        jest.mocked(window.api.getSettings).mockResolvedValue(
            invalid({ app: { noticeAcknowledgedVersion: CURRENT_NOTICE_VERSION } }),
        );
        await renderReady();
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    test('a damaged settings file is explained on the login page too', async () => {
        jest.mocked(window.api.getSettingsRecovery).mockResolvedValue(
            invalid({ success: true, recovery: { code: 'settings-unreadable', path: '/data/config.json' } }),
        );
        await renderReady();
        expect((await screen.findByRole('alert')).textContent).toContain('notice.recoveryUnreadableWhat');
    });

    test('rejected credentials get their own translated text', async () => {
        jest.mocked(window.api.authenticate).mockResolvedValue({ success: false, error: 'Invalid credentials' });
        await renderReady();
        submit('alice', 'wrong');
        await waitFor(() => expect(screen.getByText('errors.invalidCredentials')).toBeTruthy());
    });

    test('a login that could not be saved says so, with what to do, and does not transition', async () => {
        jest.mocked(window.api.authenticate).mockResolvedValue({ success: false, error: 'token-not-saved' });
        await renderReady();
        submit('alice', 'pw');
        const text = await screen.findByText('errors.tokenNotSaved');
        expect(text.closest('[role="alert"]')).not.toBeNull();
        expect(window.api.login).not.toHaveBeenCalled();
    });

    test('on Android a login that could not be saved says to restart the app, not to fix a file', async () => {
        (globalThis as RendererGlobals).Capacitor = { isNativePlatform: () => true };
        jest.mocked(window.api.authenticate).mockResolvedValue({ success: false, error: 'token-not-saved' });
        await renderReady();
        submit('alice', 'pw');
        const text = await screen.findByText('errors.tokenNotSavedAndroid');
        expect(text.closest('[role="alert"]')).not.toBeNull();
        expect(screen.queryByText('errors.tokenNotSaved')).toBeNull();
    });

    test('a failure the shell met before the page loaded shows at once, and an attempt that answers replaces it', async () => {
        jest.mocked(window.api.authenticate).mockResolvedValue({ success: false, error: 'Invalid credentials' });
        render(<LoginPage startupError="web-shell-token" />);
        const text = await screen.findByText('errors.webShellToken');
        expect(text.closest('[role="alert"]')).not.toBeNull();

        submit('alice', 'wrong');
        await waitFor(() => expect(screen.getByText('errors.invalidCredentials')).toBeTruthy());
        expect(screen.queryByText('errors.webShellToken')).toBeNull();
    });

    test('a web shell page without a valid access token says to open the printed URL', async () => {
        jest.mocked(window.api.authenticate).mockRejectedValue(new Error('web-shell-token'));
        await renderReady();
        submit('alice', 'pw');
        expect((await screen.findByText('errors.webShellToken')).closest('[role="alert"]')).not.toBeNull();
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
