import { useTranslation } from '@/contexts/TranslationContext';
import { ResetButton } from '@/components/ui/ResetButton';

import type { SettingResetHandler } from '../../../types/settingsEditor';

/**
 * The per-setting reset control every settings field ends with: resets
 * `settingKey` through `onReset`, titled as a not-yet-saved change and named
 * after the setting (`labelKey`), so each reset button of the form reads
 * differently. Renders nothing when the field has no reset (`onReset` null).
 */
export function SettingResetButton({
    settingKey,
    labelKey,
    onReset,
}: {
    settingKey: string;
    labelKey: string;
    onReset?: SettingResetHandler | null;
}) {
    const { t } = useTranslation();
    if (!onReset) return null;
    return (
        <ResetButton label={`${t('app.resetToDefaultNotSaved')}: ${t(labelKey)}`} onClick={() => onReset(settingKey)} />
    );
}
