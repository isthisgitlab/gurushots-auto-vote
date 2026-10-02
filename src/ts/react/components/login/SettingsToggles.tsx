import { useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { ThemeSelect } from '@/components/ui/ThemeSelect';
import type { TargetedEvent } from 'preact';

/**
 * A captioned toggle; the hidden On / Off words keep it the same width as the theme picker's column
 */
function ToggleField({
    id,
    label,
    checked,
    onChange,
}: {
    id: string;
    label: string;
    checked: boolean;
    onChange: (e: TargetedEvent<HTMLInputElement, Event>) => void;
}) {
    return (
        <div className="flex flex-col items-center">
            <label className="label mb-2" htmlFor={id}>
                {label}
            </label>
            <div className="flex items-center justify-center">
                <span className="invisible mr-2">Off</span>
                <input id={id} type="checkbox" className="toggle toggle-sm" checked={checked} onChange={onChange} />
                <span className="invisible ml-2">On</span>
            </div>
        </div>
    );
}

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
        (e: TargetedEvent<HTMLInputElement, Event>) => {
            void onStayLoggedInChange(e.currentTarget.checked);
        },
        [onStayLoggedInChange],
    );

    const handleMockModeToggle = useCallback(
        (e: TargetedEvent<HTMLInputElement, Event>) => {
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

                <ToggleField
                    id="login-stay-logged-in"
                    label={t('login.stayLoggedIn')}
                    checked={stayLoggedIn}
                    onChange={handleStayLoggedInToggle}
                />

                <ToggleField
                    id="login-mock-mode"
                    label={t('login.mockMode')}
                    checked={mockMode}
                    onChange={handleMockModeToggle}
                />
            </div>
        </>
    );
}
