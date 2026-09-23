/**
 * Login page (pages/Login.jsx) — hydrates theme / stay-logged-in / username
 * from settings and mock mode from the environment, persists toggle changes,
 * and on a successful auth saves the token (+ username when remembered) and
 * transitions via window.api.login(). Also covers the module-load auto-mount,
 * which the Capacitor entry suppresses with __capacitorBootstrap.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

const API_METHODS = ['getSettings', 'getEnvironmentInfo', 'authenticate', 'setSetting', 'login'];

let LoginPage;
let mountLogin;

describe('Login page', () => {
    let originals;

    beforeAll(async () => {
        // Import with no #root so the module-load mount is a no-op here.
        ({ default: LoginPage, mountLogin } = await import('@/pages/Login'));
        await Promise.resolve();
    });

    beforeEach(() => {
        originals = Object.fromEntries(API_METHODS.map((m) => [m, window.api[m]]));
        window.api.getSettings = jest.fn().mockResolvedValue({});
        window.api.getEnvironmentInfo = jest.fn().mockResolvedValue({ defaultMock: false });
        window.api.authenticate = jest.fn().mockResolvedValue({ success: true, token: 'tok' });
        window.api.setSetting = jest.fn().mockResolvedValue(undefined);
        window.api.login = jest.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
        Object.assign(window.api, originals);
        document.documentElement.removeAttribute('data-theme');
        document.body.innerHTML = '';
        delete globalThis.__capacitorBootstrap;
    });

    const renderReady = async () => {
        const utils = render(<LoginPage />);
        await waitFor(() => expect(screen.getByText('login.heading')).toBeTruthy());
        return utils;
    };

    const submit = (username, password) => {
        fireEvent.input(document.getElementById('username'), { target: { value: username } });
        fireEvent.input(document.getElementById('password'), { target: { value: password } });
        fireEvent.submit(document.querySelector('form'));
    };

    const checkboxes = () => document.querySelectorAll('input[type="checkbox"]');

    test('shows the loader, then defaults (light, not remembered, live mode)', async () => {
        render(<LoginPage />);
        expect(screen.getByText('common.loading')).toBeTruthy();
        await waitFor(() => expect(screen.getByText('login.heading')).toBeTruthy());
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        const [theme, stay, mock] = checkboxes();
        expect([theme.checked, stay.checked, mock.checked]).toEqual([false, false, false]);
        expect(document.getElementById('username').value).toBe('');
        expect(screen.getByText('login.loadingModeInfo')).toBeTruthy();
    });

    test('hydrates from settings and the environment default', async () => {
        window.api.getSettings.mockResolvedValue({ theme: 'dark', stayLoggedIn: true, lastUsername: 'bob' });
        window.api.getEnvironmentInfo.mockResolvedValue({ defaultMock: true });
        await renderReady();
        await waitFor(() => expect(document.getElementById('username').value).toBe('bob'));
        // The theme lands via a passive effect, which can trail the username commit.
        await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
        const [theme, stay, mock] = checkboxes();
        expect([theme.checked, stay.checked, mock.checked]).toEqual([true, true, true]);
        expect(screen.getByText('login.mockModeInfo')).toBeTruthy();
    });

    test('remembered without a saved username leaves the field empty', async () => {
        window.api.getSettings.mockResolvedValue({ stayLoggedIn: true });
        await renderReady();
        expect(checkboxes()[1].checked).toBe(true);
        expect(document.getElementById('username').value).toBe('');
    });

    test('env info failure keeps live mode', async () => {
        window.api.getEnvironmentInfo.mockRejectedValue(new Error('no env'));
        await renderReady();
        expect(checkboxes()[2].checked).toBe(false);
    });

    test('env info without defaultMock keeps live mode', async () => {
        window.api.getEnvironmentInfo.mockResolvedValue({});
        await renderReady();
        expect(checkboxes()[2].checked).toBe(false);
    });

    test('toggles persist theme, stay-logged-in (clearing the username when off) and mock', async () => {
        await renderReady();
        const [theme, stay, mock] = checkboxes();

        fireEvent.click(theme);
        await waitFor(() => expect(window.api.setSetting).toHaveBeenCalledWith('theme', 'dark'));
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

        fireEvent.click(stay);
        await waitFor(() => expect(window.api.setSetting).toHaveBeenCalledWith('stayLoggedIn', true));
        expect(window.api.setSetting).not.toHaveBeenCalledWith('lastUsername', '');
        await waitFor(() => expect(checkboxes()[1].checked).toBe(true));

        fireEvent.click(checkboxes()[1]);
        await waitFor(() => expect(window.api.setSetting).toHaveBeenCalledWith('lastUsername', ''));
        expect(window.api.setSetting).toHaveBeenCalledWith('stayLoggedIn', false);

        fireEvent.click(mock);
        await waitFor(() => expect(window.api.setSetting).toHaveBeenCalledWith('mock', true));
        expect(screen.getByText('login.mockModeInfo')).toBeTruthy();
    });

    test('successful login saves token + mock mode and transitions (username not remembered)', async () => {
        await renderReady();
        submit('alice', 'pw');
        await waitFor(() => expect(window.api.login).toHaveBeenCalledTimes(1));
        expect(window.api.authenticate).toHaveBeenCalledWith('alice', 'pw', false);
        expect(window.api.setSetting).toHaveBeenCalledWith('token', 'tok');
        expect(window.api.setSetting).toHaveBeenCalledWith('mock', false);
        expect(window.api.setSetting).not.toHaveBeenCalledWith('lastUsername', 'alice');
    });

    test('successful login remembers the username when stay-logged-in is on', async () => {
        window.api.getSettings.mockResolvedValue({ stayLoggedIn: true });
        await renderReady();
        submit('alice', 'pw');
        await waitFor(() => expect(window.api.login).toHaveBeenCalledTimes(1));
        expect(window.api.setSetting).toHaveBeenCalledWith('lastUsername', 'alice');
    });

    test('failed auth shows the error and does not transition', async () => {
        window.api.authenticate.mockResolvedValue({ success: false, error: 'Bad credentials' });
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

        globalThis.__capacitorBootstrap = true;
        jest.isolateModules(() => {
            require('@/pages/Login');
        });
        await Promise.resolve();
        expect(root.textContent).toBe('');

        delete globalThis.__capacitorBootstrap;
        jest.isolateModules(() => {
            require('@/pages/Login');
        });
        await Promise.resolve();
        expect(root.textContent).toBe('common.loading');
    });
});
