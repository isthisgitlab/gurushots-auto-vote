import { useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { ThemeSelect } from '@/components/ui/ThemeSelect';
import type { JSX } from 'preact';

/**
 * Settings toggles section for the login page
 * Contains the theme picker and the stay logged in and mock mode toggles
 */
export function SettingsToggles({
    theme,
    stayLoggedIn,
    mockMode,
    onThemeChange,
    onStayLoggedInChange,
    onMockModeChange,
}: {
    theme: string;
    stayLoggedIn: boolean;
    mockMode: boolean;
    onThemeChange: (theme: string) => void | Promise<void>;
    onStayLoggedInChange: (value: boolean) => void | Promise<void>;
    onMockModeChange: (value: boolean) => void | Promise<void>;
}) {
    const { t } = useTranslation();

    const handleThemeChange = useCallback(
        (newTheme: string) => {
            void onThemeChange(newTheme);
        },
        [onThemeChange],
    );

    const handleStayLoggedInToggle = useCallback(
        (e: JSX.TargetedEvent<HTMLInputElement, Event>) => {
            void onStayLoggedInChange(e.currentTarget.checked);
        },
        [onStayLoggedInChange],
    );

    const handleMockModeToggle = useCallback(
        (e: JSX.TargetedEvent<HTMLInputElement, Event>) => {
            void onMockModeChange(e.currentTarget.checked);
        },
        [onMockModeChange],
    );

    return (
        <>
            <div className="divider">{t('app.settings')}</div>

            <div className="grid grid-cols-3 gap-2">
                {/* Theme Picker */}
                <div className="flex flex-col items-center">
                    <label className="label mb-2" htmlFor="login-theme">
                        {t('common.theme')}
                    </label>
                    <ThemeSelect id="login-theme" value={theme} onChange={handleThemeChange} className="w-full" />
                </div>

                {/* Stay Logged In Toggle */}
                <div className="flex flex-col items-center">
                    <label className="label mb-2" htmlFor="login-stay-logged-in">
                        {t('login.stayLoggedIn')}
                    </label>
                    <div className="flex items-center justify-center">
                        <span className="invisible mr-2">Off</span>
                        <input
                            id="login-stay-logged-in"
                            type="checkbox"
                            className="toggle toggle-sm"
                            checked={stayLoggedIn}
                            onChange={handleStayLoggedInToggle}
                        />
                        <span className="invisible ml-2">On</span>
                    </div>
                </div>

                {/* Mock Mode Toggle */}
                <div className="flex flex-col items-center">
                    <label className="label mb-2" htmlFor="login-mock-mode">
                        {t('login.mockMode')}
                    </label>
                    <div className="flex items-center justify-center">
                        <span className="invisible mr-2">Off</span>
                        <input
                            id="login-mock-mode"
                            type="checkbox"
                            className="toggle toggle-sm"
                            checked={mockMode}
                            onChange={handleMockModeToggle}
                        />
                        <span className="invisible ml-2">On</span>
                    </div>
                </div>
            </div>
        </>
    );
}
