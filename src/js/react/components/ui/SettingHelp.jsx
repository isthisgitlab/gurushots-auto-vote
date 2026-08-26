import { useTranslation } from '@/contexts/TranslationContext';

/**
 * Optional inline "explain this" disclosure for a settings row. Renders
 * nothing unless the schema entry carries a `helpKey`. Uses a native
 * <details> (keyboard- and touch-accessible, unlike a hover-only tooltip)
 * so a deeper explanation — e.g. the two distinct meanings of a `0`
 * sentinel — is one click away without cluttering the row for users who
 * don't need it.
 */
export function SettingHelp({ helpKey }) {
    const { t } = useTranslation();
    if (!helpKey) return null;
    return (
        <details className="text-xs mb-2">
            <summary className="cursor-pointer text-info select-none inline-flex items-center gap-1">
                <span className="badge badge-info badge-xs">?</span>
                {t('app.settingHelpLabel')}
            </summary>
            <p className="mt-1 text-base-content/70">{t(helpKey)}</p>
        </details>
    );
}
