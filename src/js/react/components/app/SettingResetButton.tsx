import { useTranslation } from '@/contexts/TranslationContext';
import { ResetButton } from '@/components/ui/ResetButton';

import type { SettingResetHandler } from '../../../types/settingsEditor';

/**
 * The per-setting reset control every settings field ends with: resets
 * `settingKey` through `onReset`, titled as a not-yet-saved change. Renders
 * nothing when the field has no reset (`onReset` null).
 */
export function SettingResetButton({
    settingKey,
    onReset,
}: {
    settingKey: string;
    onReset?: SettingResetHandler | null;
}) {
    const { t } = useTranslation();
    if (!onReset) return null;
    return <ResetButton title={t('app.resetToDefaultNotSaved')} onClick={() => onReset(settingKey)} />;
}
