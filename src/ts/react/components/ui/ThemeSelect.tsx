import { useTranslation } from '@/contexts/TranslationContext';
import { THEMES } from '../../../core/settings/uiDefaults';

/**
 * Picker over every DaisyUI theme the stylesheet compiles, shared by the
 * Settings modal and the login page.
 */
export function ThemeSelect({
    id,
    value,
    onChange,
    className = '',
    invalid = false,
    describedBy,
}: {
    id: string;
    value: string;
    onChange: (theme: string) => void;
    className?: string;
    invalid?: boolean;
    /** An element id the select points at with aria-describedby (a hint beside it). */
    describedBy?: string;
}) {
    const { t } = useTranslation();
    return (
        <select
            id={id}
            className={`select select-sm ${className}`}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
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
