import { createRoot } from 'react-dom/client';
import { useState, useEffect, useCallback } from 'react';
import { TranslationProvider, useTranslation } from '@/contexts/TranslationContext';
import { useSettings, useEnvironmentInfo } from '@/api/useSettings';
import { useAuth } from '@/api/useAuth';
import { LoginForm } from '@/components/login/LoginForm';
import { LanguageSwitcher } from '@/components/login/LanguageSwitcher';
import { SettingsToggles } from '@/components/login/SettingsToggles';
import { ModeInfoText } from '@/components/login/ModeInfoText';
import { PageLoader } from '@/components/ui/LoadingSpinner';

/**
 * Login page content component
 */
function LoginPageContent() {
    const { ready, t } = useTranslation();
    const { settings, loading: settingsLoading, updateSetting } = useSettings();
    const { envInfo, loading: envLoading } = useEnvironmentInfo();
    const { authenticate, login, loading: authLoading, error: authError } = useAuth();

    // Local state
    const [theme, setTheme] = useState('light');
    const [stayLoggedIn, setStayLoggedIn] = useState(false);
    const [mockMode, setMockMode] = useState(false);
    const [initialUsername, setInitialUsername] = useState('');

    // Initialize state from settings
    useEffect(() => {
        if (settings) {
            setTheme(settings.theme || 'light');
            setStayLoggedIn(settings.stayLoggedIn || false);

            // Pre-fill username if stay logged in is enabled
            if (settings.stayLoggedIn && settings.lastUsername) {
                setInitialUsername(settings.lastUsername);
            }
        }
    }, [settings]);

    // Initialize mock mode from environment
    useEffect(() => {
        if (envInfo) {
            setMockMode(envInfo.defaultMock || false);
        }
    }, [envInfo]);

    // Apply theme to document
    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
    }, [theme]);

    // Handle theme change
    const handleThemeChange = useCallback(
        async (newTheme) => {
            setTheme(newTheme);
            document.documentElement.setAttribute('data-theme', newTheme);
            await updateSetting('theme', newTheme);
        },
        [updateSetting],
    );

    // Handle stay logged in change
    const handleStayLoggedInChange = useCallback(
        async (value) => {
            setStayLoggedIn(value);
            await updateSetting('stayLoggedIn', value);

            // Clear saved username if toggling off
            if (!value) {
                await updateSetting('lastUsername', '');
            }
        },
        [updateSetting],
    );

    // Handle mock mode change
    const handleMockModeChange = useCallback(
        async (value) => {
            setMockMode(value);
            await updateSetting('mock', value);
        },
        [updateSetting],
    );

    // Handle form submission
    const handleSubmit = useCallback(
        async (username, password) => {
            const result = await authenticate(username, password, mockMode);

            if (result.success) {
                await updateSetting('token', result.token);

                // Save username if stay logged in is enabled
                if (stayLoggedIn) {
                    await updateSetting('lastUsername', username);
                }

                // Save mock mode setting
                await updateSetting('mock', mockMode);

                // Transition to main window
                await login();
            }
        },
        [authenticate, login, mockMode, stayLoggedIn, updateSetting],
    );

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

                    {/* Title */}
                    <h2 className="card-title text-2xl font-bold text-center mb-6">{t('login.heading')}</h2>

                    {/* Auth Error */}
                    {authError && (
                        <div className="alert alert-error mb-4">
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                className="stroke-current shrink-0 h-6 w-6"
                                fill="none"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth="2"
                                    d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
                                />
                            </svg>
                            <span>{authError}</span>
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
        </div>
    );
}

/**
 * Login page with providers
 */
function LoginPage() {
    return (
        <TranslationProvider>
            <LoginPageContent />
        </TranslationProvider>
    );
}

// Mount the React app at module load. The Capacitor entry sets
// __capacitorBootstrap before importing this module so it can
// conditionally mount Login vs App; everywhere else (Electron's
// loginWindow) auto-mounts as before.
export const mountLogin = () => {
    const container = document.getElementById('root');
    if (container) {
        const root = createRoot(container);
        root.render(<LoginPage />);
    }
};

if (!globalThis.__capacitorBootstrap) {
    mountLogin();
}

export default LoginPage;
