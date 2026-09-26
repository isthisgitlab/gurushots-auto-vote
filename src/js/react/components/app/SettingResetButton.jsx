// @ts-check
import { useTranslation } from '@/contexts/TranslationContext';
import { ResetButton } from '@/components/ui/ResetButton';

/** @import { SettingResetHandler } from '../../../types/settingsEditor' */

/**
 * The per-setting reset control every settings field ends with: resets
 * `settingKey` through `onReset`, titled as a not-yet-saved change. Renders
 * nothing when the field has no reset (`onReset` null).
 *
 * @param {{ settingKey: string, onReset?: SettingResetHandler | null }} props
 */
export function SettingResetButton({ settingKey, onReset }) {
    const { t } = useTranslation();
    if (!onReset) return null;
    return <ResetButton title={t('app.resetToDefaultNotSaved')} onClick={() => onReset(settingKey)} />;
}
