import { useTranslation } from '@/contexts/TranslationContext';
import { ResetIcon } from './ResetButton';
import { StrokeIcon, ICON_PATHS } from './StrokeIcon';

const ROW_ICON_CLASS = 'w-4 h-4 mr-1';

/**
 * Shared Save / secondary / Cancel action row used by the settings
 * modals (SettingsModal renders it twice — top and bordered bottom —
 * and ChallengeSettingsModal once).
 *
 * @param props.saving        - disables Save and shows the spinner
 * @param props.onSecondary - warning button handler (Reset All / Clear All)
 * @param props.secondaryLabel - already-translated warning button label
 * @param props.bordered    - adds the top border + padding variant
 */
export function ModalActionRow({
    onSave,
    saving,
    onSecondary,
    secondaryLabel,
    secondaryIcon = 'reset',
    onCancel,
    bordered = false,
}: {
    onSave: () => void | Promise<void>;
    saving: boolean;
    onSecondary: () => void | Promise<void>;
    secondaryLabel: string;
    secondaryIcon?: 'reset' | 'trash';
    onCancel: () => void;
    bordered?: boolean;
}) {
    const { t } = useTranslation();

    return (
        <div className={bordered ? 'flex justify-end gap-2 pt-4 border-t border-base-300' : 'flex justify-end gap-2'}>
            <button className="btn btn-latvian btn-sm" onClick={() => void onSave()} disabled={saving}>
                {saving && <span className="loading loading-spinner loading-xs" />}
                <StrokeIcon d={ICON_PATHS.save} className={ROW_ICON_CLASS} />
                {t('app.save')}
            </button>
            <button className="btn btn-warning btn-sm" onClick={() => void onSecondary()}>
                {secondaryIcon === 'trash' ? (
                    <StrokeIcon d={ICON_PATHS.trash} className={ROW_ICON_CLASS} />
                ) : (
                    <ResetIcon className={ROW_ICON_CLASS} />
                )}
                {secondaryLabel}
            </button>
            <button className="btn btn-outline btn-sm" onClick={onCancel}>
                {t('app.cancel')}
            </button>
        </div>
    );
}
