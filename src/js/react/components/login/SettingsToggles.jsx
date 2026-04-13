import { useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';

/**
 * Settings toggles section for the login page
 * Contains theme, stay logged in, and mock mode toggles
 */
export function SettingsToggles({
    theme,
    stayLoggedIn,
    mockMode,
    onThemeChange,
    onStayLoggedInChange,
    onMockModeChange,
}) {
    const { t } = useTranslation();

    const handleThemeToggle = useCallback((e) => {
        const isDark = e.target.checked;
        const newTheme = isDark ? 'dark' : 'light';
        onThemeChange(newTheme);
    }, [onThemeChange]);

    const handleStayLoggedInToggle = useCallback((e) => {
        onStayLoggedInChange(e.target.checked);
    }, [onStayLoggedInChange]);

    const handleMockModeToggle = useCallback((e) => {
        onMockModeChange(e.target.checked);
    }, [onMockModeChange]);

    return (
        <>
            <div className="divider">Settings</div>

            <div className="grid grid-cols-3 gap-2">
                {/* Theme Toggle */}
                <div className="flex flex-col items-center">
                    <span className="label-text mb-2">{t('common.theme')}</span>
                    <div className="flex items-center justify-center">
                        <span className="label-text mr-2">{t('common.light')}</span>
                        <input
                            type="checkbox"
                            className="toggle toggle-sm"
                            checked={theme === 'dark'}
                            onChange={handleThemeToggle}
                        />
                        <span className="label-text ml-2">{t('common.dark')}</span>
                    </div>
                </div>

                {/* Stay Logged In Toggle */}
                <div className="flex flex-col items-center">
                    <span className="label-text mb-2">{t('login.stayLoggedIn')}</span>
                    <div className="flex items-center justify-center">
                        <span className="invisible label-text mr-2">Off</span>
                        <input
                            type="checkbox"
                            className="toggle toggle-sm"
                            checked={stayLoggedIn}
                            onChange={handleStayLoggedInToggle}
                        />
                        <span className="invisible label-text ml-2">On</span>
                    </div>
                </div>

                {/* Mock Mode Toggle */}
                <div className="flex flex-col items-center">
                    <span className="label-text mb-2">{t('login.mockMode')}</span>
                    <div className="flex items-center justify-center">
                        <span className="invisible label-text mr-2">Off</span>
                        <input
                            type="checkbox"
                            className="toggle toggle-sm"
                            checked={mockMode}
                            onChange={handleMockModeToggle}
                        />
                        <span className="invisible label-text ml-2">On</span>
                    </div>
                </div>
            </div>
        </>
    );
}
