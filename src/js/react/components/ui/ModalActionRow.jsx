import { useTranslation } from '@/contexts/TranslationContext';
import { ResetIcon } from './ResetButton';
import { StrokeIcon, ICON_PATHS } from './StrokeIcon';

const ROW_ICON_CLASS = 'w-4 h-4 mr-2';

/**
 * Shared Save / secondary / Cancel action row used by the settings
 * modals (SettingsModal renders it twice — top and bordered bottom —
 * and ChallengeSettingsModal once). Markup and DaisyUI classes match
 * the previous inline copies exactly.
 *
 * @param {object} props
 * @param {Function} props.onSave
 * @param {boolean} props.saving        - disables Save and shows the spinner
 * @param {Function} props.onSecondary  - warning button handler (Reset All / Clear All)
 * @param {string} props.secondaryLabel - already-translated warning button label
 * @param {'reset'|'trash'} [props.secondaryIcon]
 * @param {Function} props.onCancel
 * @param {boolean} [props.bordered]    - adds the top border + padding variant
 */
export function ModalActionRow({
    onSave,
    saving,
    onSecondary,
    secondaryLabel,
    secondaryIcon = 'reset',
    onCancel,
    bordered = false,
}) {
    const { t } = useTranslation();

    return (
        <div className={bordered ? 'flex justify-end gap-2 pt-4 border-t border-base-300' : 'flex justify-end gap-2'}>
            <button className="btn btn-latvian" onClick={onSave} disabled={saving}>
                {saving && <span className="loading loading-spinner loading-xs" />}
                <StrokeIcon d={ICON_PATHS.save} className={ROW_ICON_CLASS} />
                {t('app.save')}
            </button>
            <button className="btn btn-warning" onClick={onSecondary}>
                {secondaryIcon === 'trash' ? (
                    <StrokeIcon d={ICON_PATHS.trash} className={ROW_ICON_CLASS} />
                ) : (
                    <ResetIcon className={ROW_ICON_CLASS} />
                )}
                {secondaryLabel}
            </button>
            <button className="btn" onClick={onCancel}>
                {t('app.cancel')}
            </button>
        </div>
    );
}
