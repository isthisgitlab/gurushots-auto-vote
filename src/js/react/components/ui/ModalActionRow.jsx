import { useTranslation } from '@/contexts/TranslationContext';
import { ResetIcon } from './ResetButton';

/**
 * Save-checkmark glyph shared by the modal action rows.
 */
export function SaveIcon({ className = 'w-4 h-4 mr-2' }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
        </svg>
    );
}

function TrashIcon() {
    return (
        <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
        </svg>
    );
}

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
                <SaveIcon />
                {t('app.save')}
            </button>
            <button className="btn btn-warning" onClick={onSecondary}>
                {secondaryIcon === 'trash' ? <TrashIcon /> : <ResetIcon className="w-4 h-4 mr-2" />}
                {secondaryLabel}
            </button>
            <button className="btn" onClick={onCancel}>
                {t('app.cancel')}
            </button>
        </div>
    );
}
