import type { RendererGlobals } from '../../types/capacitor';
import { createRoot } from 'react-dom/client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { TranslationProvider, useTranslation } from '@/contexts/TranslationContext';
import { useSettings, useEnvironmentInfo } from '@/api/useSettings';
import { useAuth } from '@/api/useAuth';
import { LoginForm } from '@/components/login/LoginForm';
import { LanguageSwitcher } from '@/components/login/LanguageSwitcher';
import { SettingsToggles } from '@/components/login/SettingsToggles';
import { ModeInfoText } from '@/components/login/ModeInfoText';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';
import { useDocumentTheme } from '@/hooks/useDocumentTheme';
import { useNoticeGate } from '@/hooks/useNoticeGate';
import { UnofficialNoticeModal } from '@/components/app/UnofficialNoticeModal';
import { SettingsRecoveryNotice } from '@/components/app/SettingsRecoveryNotice';
import { ipcErrorText } from '@/api/ipcErrorText';
import * as ipc from '@/api/ipc';
import { isPlainObject } from '../../plainObject';
import { usePlatformCapabilities } from '@/api/usePlatformCapabilities';

/**
 * Login page content component
 */
function LoginPageContent({ startupError }: { startupError?: string }) {
    const { ready, t } = useTranslation();
    const { settings, loading: settingsLoading, updateSetting } = useSettings();
    const { envInfo, loading: envLoading } = useEnvironmentInfo();
    const notice = useNoticeGate(settings, settingsLoading, updateSetting);
    const { authenticate, login, loading: authLoading, error: authError } = useAuth();
    const { settingsFile } = usePlatformCapabilities();
    // Where focus goes when the settings notice has nothing of its own left to return it to.
    const headingRef = useRef<HTMLHeadingElement>(null);

    // Local state
    const [theme, setTheme] = useState('light');
    const [stayLoggedIn, setStayLoggedIn] = useState(false);
    const [mockMode, setMockMode] = useState(false);
    const [initialUsername, setInitialUsername] = useState('');

    useEffect(() => {
        if (settings) {
            setTheme(settings.app.theme || 'light');
            setStayLoggedIn(settings.app.stayLoggedIn || false);

            // Pre-fill username if stay logged in is enabled. The saved name is part of the sign-in state, which the
            // settings the renderer is handed leave out: it is read on its own.
            if (settings.app.stayLoggedIn) {
                void ipc.getSetting('lastUsername').then((saved) => {
                    if (typeof saved === 'string' && saved !== '') setInitialUsername(saved);
                });
            }
        }
    }, [settings]);

    useEffect(() => {
        if (envInfo) {
            setMockMode(envInfo.defaultMock || false);
        }
    }, [envInfo]);

    useDocumentTheme(theme);

    const handleThemeChange = useCallback(
        async (newTheme: string) => {
            setTheme(newTheme);
            document.documentElement.setAttribute('data-theme', newTheme);
            await updateSetting('theme', newTheme);
        },
        [updateSetting],
    );

    const handleStayLoggedInChange = useCallback(
        async (value: boolean) => {
            setStayLoggedIn(value);
            // Turning it off also clears the saved username: the main process does that with the write.
            await updateSetting('stayLoggedIn', value);
        },
        [updateSetting],
    );

    const handleMockModeChange = useCallback(
        async (value: boolean) => {
            setMockMode(value);
            await updateSetting('mock', value);
        },
        [updateSetting],
    );

    // Whether this page has started the move to the app (a login made here, or a stored session that arrived): once, so
    // that a login does not also move on because its own token was stored.
    const moving = useRef(false);

    const handleSubmit = useCallback(
        async (username: string, password: string) => {
            moving.current = true;
            let moved = false;
            try {
                const result = await authenticate(username, password, mockMode);

                if (result.success) {
                    // The main process saved the username when stay logged in is on, as part of the login.
                    await updateSetting('mock', mockMode);

                    // Transition to main window
                    await login();
                    moved = true;
                }
            } finally {
                // A login that failed, or threw on the way, leaves the page free to move on when a session arrives.
                if (!moved) moving.current = false;
            }
        },
        [authenticate, login, mockMode, updateSetting],
    );

    // A session that is stored while this page shows, without a login made here (the settings a pending restore was
    // waiting for came through, or another process signed in), moves on to the app as a login does. Only for a session
    // that is kept (Stay logged in), as at the start.
    useEffect(() => {
        const unsubscribe = ipc.onSettingsChanged?.((changed: unknown) => {
            const app = isPlainObject(changed) ? changed.app : undefined;
            if (moving.current || !isPlainObject(changed) || changed.hasToken !== true) return;
            if (!isPlainObject(app) || app.stayLoggedIn !== true) return;
            moving.current = true;
            // (If the shell ignores the move, as the main process does when no session is stored after all, the page is still
            // here, and a later session may move it.)
            void login().finally(() => {
                moving.current = false;
            });
        });
        return () => unsubscribe?.();
    }, [login]);

    // A failure the shell reported before any login attempt shows until an attempt answers.
    const shownError = authError ?? startupError;
    // A login that could not be saved: the next step differs where the settings are not a file the user can open.
    const shownText =
        shownError === 'token-not-saved' && !settingsFile
            ? t('errors.tokenNotSavedAndroid')
            : ipcErrorText(shownError, t, 'errors.loginFailed');

    // Show loading while initializing
    if (!ready || settingsLoading || envLoading) {
        return <PageLoader text={t('common.loading')} />;
    }

    return (
        <div className="min-h-screen bg-base-200 flex items-center justify-center">
            <div className="card w-full max-w-lg bg-base-100 shadow-xl">
                <div className="card-body">
                    {/* Language Switcher */}
                    <LanguageSwitcher />

                    <SettingsRecoveryNotice returnFocusTo={headingRef} />

                    {/* Title */}
                    <h2
                        ref={headingRef}
                        tabIndex={-1}
                        className="card-title text-2xl font-bold text-center mb-6 focus-visible:ring-primary focus-visible:ring-2 focus-visible:outline-none"
                    >
                        {t('login.heading')}
                    </h2>

                    {/* Auth Error */}
                    {shownError && (
                        <div className="alert alert-error mb-4" role="alert">
                            <StrokeIcon className="stroke-current shrink-0 h-6 w-6" d={ICON_PATHS.xCircle} />
                            <span>{shownText}</span>
                        </div>
                    )}

                    {/* Login Form */}
                    <LoginForm onSubmit={handleSubmit} loading={authLoading} initialUsername={initialUsername} />

                    {/* Settings Toggles */}
                    <SettingsToggles
                        theme={theme}
                        stayLoggedIn={stayLoggedIn}
                        mockMode={mockMode}
                        onThemeChange={handleThemeChange}
                        onStayLoggedInChange={handleStayLoggedInChange}
                        onMockModeChange={handleMockModeChange}
                    />

                    {/* Mode Info Text */}
                    <ModeInfoText isMock={mockMode} />
                </div>
            </div>

            {/* Shown here when there is no auto-login; with one, the app page shows it instead */}
            <UnofficialNoticeModal isOpen={notice.open} onAcknowledge={() => void notice.acknowledge()} />
        </div>
    );
}

/**
 * Login page with providers
 *
 * @param startupError - an IPC failure the shell met before the page loaded, shown as a login error
 */
function LoginPage({ startupError }: { startupError?: string }) {
    return (
        <TranslationProvider>
            <LoginPageContent startupError={startupError} />
        </TranslationProvider>
    );
}

// Mount the React app at module load. The Capacitor entry sets
// __capacitorBootstrap before importing this module so it can
// conditionally mount Login vs App; everywhere else (Electron's
// loginWindow) auto-mounts.
export const mountLogin = (startupError?: string) => {
    const container = document.getElementById('root');
    if (container) {
        const root = createRoot(container);
        root.render(<LoginPage startupError={startupError} />);
    }
};

// Deferred via queueMicrotask: see App.tsx for the full reasoning —
// ESM import hoisting moves Capacitor.tsx's bootstrap-flag assignment
// after its imports, so the check has to wait a microtask to see it.
queueMicrotask(() => {
    if (!(globalThis as RendererGlobals).__capacitorBootstrap) {
        mountLogin();
    }
});

export default LoginPage;
