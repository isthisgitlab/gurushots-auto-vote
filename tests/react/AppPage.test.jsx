/**
 * Main App page (pages/App.jsx) — the shell that wires settings, challenges,
 * autovote and the modals together. Child sections/modals and the
 * challenge/autovote/update providers are stubbed so each stub records the
 * props App hands it; the tests then drive App's handlers through those props
 * (open/close modals, logout, welcome persistence, autovote toggle, joins) and
 * assert what App does. Settings flow through the real useSettings hook over
 * the window.api mock.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { DEFAULT_TIMEZONE } from '../../src/js/settings/uiDefaults';

const mockProps = {};
const mockChallenges = { challenges: [], refetch: jest.fn() };
const mockBankroll = { bankroll: { coins: 5 }, refetch: jest.fn() };
const mockAutovote = {
    running: false,
    status: 'idle',
    statusClass: 'x',
    lastRun: null,
    cycles: 0,
    nextRunAt: null,
    stop: jest.fn(),
    toggle: jest.fn(),
};

const mockStub = (name) => (props) => {
    mockProps[name] = props;
    return props.children ?? null;
};

jest.mock('@/contexts/ChallengesContext', () => ({
    ChallengesProvider: mockStub('ChallengesProvider'),
    useChallenges: () => mockChallenges,
}));
jest.mock('@/contexts/AutovoteContext', () => ({
    AutovoteProvider: mockStub('AutovoteProvider'),
    useAutovote: () => mockAutovote,
}));
jest.mock('@/contexts/UpdateContext', () => ({ UpdateProvider: mockStub('UpdateProvider') }));
jest.mock('@/api/useBankroll', () => ({ useBankroll: () => mockBankroll }));
jest.mock('@/api/useAutoJoinActive', () => ({ useAutoJoinActive: () => ({ active: true }) }));
jest.mock('@/components/app/AutoVoteControls', () => ({ AutoVoteControls: mockStub('AutoVoteControls') }));
jest.mock('@/components/app/StatusHeader', () => ({ StatusHeader: mockStub('StatusHeader') }));
jest.mock('@/components/app/DiscoverSection', () => ({ DiscoverSection: mockStub('DiscoverSection') }));
jest.mock('@/components/app/ChallengesSection', () => ({ ChallengesSection: mockStub('ChallengesSection') }));
jest.mock('@/components/app/SettingsModal', () => ({ SettingsModal: mockStub('SettingsModal') }));
jest.mock('@/components/app/ChallengeSettingsModal', () => ({
    ChallengeSettingsModal: mockStub('ChallengeSettingsModal'),
}));
jest.mock('@/components/app/LogsModal', () => ({ LogsModal: mockStub('LogsModal') }));
jest.mock('@/components/app/UpdateDialog', () => ({ UpdateDialog: mockStub('UpdateDialog') }));
jest.mock('@/components/app/WelcomeModal', () => ({ WelcomeModal: mockStub('WelcomeModal') }));

let App;
let mountApp;

const API_METHODS = ['getSettings', 'setSetting', 'logout', 'logError'];

describe('App page', () => {
    let originals;

    beforeAll(async () => {
        // Imported with no #root, so the module-load auto-mount is a no-op.
        ({ default: App, mountApp } = await import('@/pages/App'));
        await Promise.resolve();
    });

    beforeEach(() => {
        for (const k of Object.keys(mockProps)) delete mockProps[k];
        mockChallenges.challenges = [];
        mockAutovote.running = false;
        mockAutovote.cycles = 0;
        originals = Object.fromEntries(API_METHODS.map((m) => [m, window.api[m]]));
        window.api.getSettings = jest.fn().mockResolvedValue({ onboardingCompleted: true });
        window.api.setSetting = jest.fn().mockResolvedValue(undefined);
        window.api.logout = jest.fn().mockResolvedValue(undefined);
        window.api.logError = jest.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
        Object.assign(window.api, originals);
        document.documentElement.removeAttribute('data-theme');
        document.body.innerHTML = '';
        delete globalThis.Capacitor;
        delete globalThis.__capacitorBootstrap;
    });

    const renderReady = async () => {
        const utils = render(<App />);
        await waitFor(() => expect(screen.getByText('app.title')).toBeTruthy());
        return utils;
    };

    test('shows the loader until translations + settings are ready', async () => {
        render(<App />);
        expect(screen.getByText('common.loading')).toBeTruthy();
        await waitFor(() => expect(screen.getByText('app.title')).toBeTruthy());
    });

    test('logged-in mock user: theme applied, props derived from settings', async () => {
        mockChallenges.challenges = [{ id: 1, close_time: 1 }];
        window.api.getSettings.mockResolvedValue({
            theme: 'dark',
            token: 'tok',
            mock: true,
            timezone: 'Europe/Riga',
            onboardingCompleted: true,
        });
        await renderReady();
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
        expect(screen.getByText('app.mockMode')).toBeTruthy();
        expect(mockProps.ChallengesSection).toMatchObject({
            timezone: 'Europe/Riga',
            isLoggedIn: true,
            autovoteRunning: false,
            bankroll: { coins: 5 },
            onBankrollChanged: mockBankroll.refetch,
        });
        expect(mockProps.StatusHeader).toMatchObject({
            challenges: mockChallenges.challenges,
            autoJoinActive: true,
            running: false,
        });
        expect(mockProps.DiscoverSection.isLoggedIn).toBe(true);
        expect(mockProps.WelcomeModal.isOpen).toBe(false);
        expect(mockProps.AutovoteProvider.onChallengesRefresh).toBe(mockChallenges.refetch);
    });

    test('empty settings fall back to defaults and leave the theme untouched', async () => {
        window.api.getSettings.mockResolvedValue({ onboardingCompleted: true });
        await renderReady();
        expect(document.documentElement.getAttribute('data-theme')).toBeNull();
        expect(screen.queryByText('app.mockMode')).toBeNull();
        expect(mockProps.ChallengesSection).toMatchObject({ timezone: DEFAULT_TIMEZONE, isLoggedIn: false });
    });

    test('first run opens the welcome once; closing persists onboardingCompleted', async () => {
        window.api.getSettings.mockResolvedValue({});
        await renderReady();
        await waitFor(() => expect(mockProps.WelcomeModal.isOpen).toBe(true));

        await act(async () => {
            await mockProps.WelcomeModal.onClose();
        });
        expect(window.api.setSetting).toHaveBeenCalledWith('onboardingCompleted', true);
        expect(mockProps.WelcomeModal.isOpen).toBe(false);
        expect(window.api.logError).not.toHaveBeenCalled();
    });

    test.each([
        [new Error('disk full'), 'Failed to persist onboardingCompleted: disk full'],
        [undefined, 'Failed to persist onboardingCompleted: undefined'],
    ])('a failed welcome persist is logged and does not reopen (%p)', async (err, logged) => {
        window.api.getSettings.mockResolvedValue({});
        await renderReady();
        await waitFor(() => expect(mockProps.WelcomeModal.isOpen).toBe(true));
        window.api.setSetting.mockRejectedValue(err);

        await act(async () => {
            await mockProps.WelcomeModal.onClose();
        });
        expect(window.api.logError).toHaveBeenCalledWith(logged);
        // The failed write refetched settings (still not onboarded) — ref-gated,
        // so the modal stays closed.
        await waitFor(() => expect(window.api.getSettings.mock.calls.length).toBeGreaterThan(1));
        expect(mockProps.WelcomeModal.isOpen).toBe(false);
    });

    test('logout when idle just logs out', async () => {
        await renderReady();
        fireEvent.click(screen.getByTitle('app.logout'));
        await waitFor(() => expect(window.api.logout).toHaveBeenCalledTimes(1));
        expect(mockAutovote.stop).not.toHaveBeenCalled();
    });

    test('logout while autovote runs stops it first', async () => {
        mockAutovote.running = true;
        await renderReady();
        fireEvent.click(screen.getByTitle('app.logout'));
        await waitFor(() => expect(window.api.logout).toHaveBeenCalledTimes(1));
        expect(mockAutovote.stop).toHaveBeenCalledTimes(1);
        expect(mockAutovote.stop.mock.invocationCallOrder[0]).toBeLessThan(
            window.api.logout.mock.invocationCallOrder[0],
        );
    });

    test.each([
        [new Error('net'), 'Error during logout: net'],
        ['plain', 'Error during logout: plain'],
    ])('a failed logout is logged (%p)', async (err, logged) => {
        window.api.logout.mockRejectedValue(err);
        await renderReady();
        fireEvent.click(screen.getByTitle('app.logout'));
        await waitFor(() => expect(window.api.logError).toHaveBeenCalledWith(logged));
    });

    test('settings and logs modals open from the navbar and close via onClose', async () => {
        globalThis.Capacitor = { isNativePlatform: () => true };
        await renderReady();
        expect(mockProps.SettingsModal.isOpen).toBe(false);
        fireEvent.click(screen.getByTitle('app.settings'));
        await waitFor(() => expect(mockProps.SettingsModal.isOpen).toBe(true));
        act(() => mockProps.SettingsModal.onClose());
        expect(mockProps.SettingsModal.isOpen).toBe(false);

        expect(mockProps.LogsModal.isOpen).toBe(false);
        fireEvent.click(screen.getByTitle('logs.title'));
        await waitFor(() => expect(mockProps.LogsModal.isOpen).toBe(true));
        act(() => mockProps.LogsModal.onClose());
        expect(mockProps.LogsModal.isOpen).toBe(false);
    });

    test('challenge settings open for the live challenge object, ignore a repeat, switch, and close', async () => {
        mockChallenges.challenges = [
            { id: 5, title: 'Five' },
            { id: 6, title: 'Six' },
        ];
        await renderReady();
        expect(mockProps.ChallengeSettingsModal).toMatchObject({ isOpen: false, challengeId: null, challenge: null });

        act(() => mockProps.ChallengesSection.onChallengeSettingsClick('5', 'Five'));
        expect(mockProps.ChallengeSettingsModal).toMatchObject({
            isOpen: true,
            challengeId: '5',
            challengeTitle: 'Five',
            challenge: mockChallenges.challenges[0],
        });

        // Same challenge while open: no state churn.
        const before = mockProps.ChallengeSettingsModal;
        act(() => mockProps.ChallengesSection.onChallengeSettingsClick('5', 'Five'));
        expect(mockProps.ChallengeSettingsModal).toBe(before);

        // A challenge no longer in the list resolves to null.
        act(() => mockProps.ChallengesSection.onChallengeSettingsClick('99', 'Gone'));
        expect(mockProps.ChallengeSettingsModal).toMatchObject({ challengeId: '99', challenge: null });

        act(() => mockProps.ChallengeSettingsModal.onClose());
        expect(mockProps.ChallengeSettingsModal).toMatchObject({ isOpen: false, challengeId: null });
    });

    test('autovote toggle and discover joins delegate to the hooks', async () => {
        await renderReady();
        expect(mockProps.AutoVoteControls).toMatchObject({ running: false, status: 'idle', statusClass: 'x' });
        await act(async () => {
            await mockProps.AutoVoteControls.onToggle();
        });
        expect(mockAutovote.toggle).toHaveBeenCalledTimes(1);

        act(() => mockProps.DiscoverSection.onJoined());
        expect(mockBankroll.refetch).toHaveBeenCalledTimes(1);
        expect(mockChallenges.refetch).toHaveBeenCalledTimes(1);
    });

    test('each completed autovote cycle refreshes the header bankroll', async () => {
        const { rerender } = await renderReady();
        // cycles === 0 on mount: the hook's own mount fetch covers it.
        expect(mockBankroll.refetch).not.toHaveBeenCalled();

        mockAutovote.cycles = 1;
        rerender(<App />);
        await waitFor(() => expect(mockBankroll.refetch).toHaveBeenCalledTimes(1));

        mockAutovote.cycles = 2;
        rerender(<App />);
        await waitFor(() => expect(mockBankroll.refetch).toHaveBeenCalledTimes(2));
    });

    test('autovote running-changed events feed the challenges provider', async () => {
        const { unmount } = await renderReady();
        expect(mockProps.ChallengesProvider.autovoteRunning).toBe(false);
        act(() => {
            window.dispatchEvent(new CustomEvent('autovote:running-changed', { detail: true }));
        });
        expect(mockProps.ChallengesProvider.autovoteRunning).toBe(true);
        act(() => {
            window.dispatchEvent(new CustomEvent('autovote:running-changed', {}));
        });
        expect(mockProps.ChallengesProvider.autovoteRunning).toBe(false);

        // The listener is removed on unmount.
        unmount();
        const last = mockProps.ChallengesProvider;
        window.dispatchEvent(new CustomEvent('autovote:running-changed', { detail: true }));
        expect(mockProps.ChallengesProvider).toBe(last);
    });

    test('mountApp renders into #root and is a no-op without it', async () => {
        mountApp();
        expect(document.body.textContent).toBe('');

        const root = document.createElement('div');
        root.id = 'root';
        document.body.appendChild(root);
        mountApp();
        await waitFor(() => expect(root.textContent).toContain('app.title'));
    });

    test('module load auto-mounts unless the Capacitor bootstrap flag is set', async () => {
        const root = document.createElement('div');
        root.id = 'root';
        document.body.appendChild(root);

        globalThis.__capacitorBootstrap = true;
        jest.isolateModules(() => {
            require('@/pages/App');
        });
        await Promise.resolve();
        expect(root.textContent).toBe('');

        delete globalThis.__capacitorBootstrap;
        jest.isolateModules(() => {
            require('@/pages/App');
        });
        await Promise.resolve();
        expect(root.textContent).toBe('common.loading');
    });
});
