import { useTranslation } from '@/contexts/TranslationContext';
import { THEMES } from '../../../settings/uiDefaults';

/**
 * Picker over every DaisyUI theme the stylesheet compiles, shared by the
 * Settings modal and the login page.
 */
export function ThemeSelect({
    id,
    value,
    onChange,
    className = '',
}: {
    id: string;
    value: string;
    onChange: (theme: string) => void;
    className?: string;
}) {
    const { t } = useTranslation();
    return (
        <select
            id={id}
            className={`select select-sm ${className}`}
            value={value}
            onChange={(e) => onChange(e.currentTarget.value)}
        >
            {THEMES.map((theme) => (
                <option key={theme} value={theme}>
                    {t(`themes.${theme}`)}
                </option>
            ))}
        </select>
    );
}
