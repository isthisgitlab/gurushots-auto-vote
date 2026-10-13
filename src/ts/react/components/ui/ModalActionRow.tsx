import { useTranslation } from '@/contexts/TranslationContext';
import { LoadingSpinner } from './LoadingSpinner';
import { ResetIcon } from './ResetButton';
import { StrokeIcon, ICON_PATHS } from './StrokeIcon';

const ROW_ICON_CLASS = 'w-4 h-4 mr-1';

// The modal hosting the row must put this on its `.modal-box` (via Modal's
// `className`): the opaque footer covers the bottom of the scroll area, and the
// scroll padding keeps a focused control scrolled above it. On phones the
// footer is at its tallest, about 13.2rem (buttons wrapped onto two rows and a
// multi-line Latvian save-error alert at 320px), so 15rem; from `md` up the
// hosts' `size="2xl"` box is at least ~704px, the buttons fit one row and it is
// about 7rem, so 8rem. Each includes room for the focus ring. A larger Android
// system font scale can still outgrow the phone value.
export const MODAL_ACTION_ROW_SCROLL_PADDING = 'scroll-pb-60 md:scroll-pb-32';

/**
 * Shared Save / secondary / Cancel action row used by the settings modals
 * (SettingsModal and ChallengeSettingsModal). It is a footer pinned to the
 * bottom of the modal's scroll area: render it as the last child of the modal
 * content. The negative margins cancel the modal box's padding so the bar sits
 * flush with the box edges and the opaque background hides the content
 * scrolling underneath. The hosting modal passes
 * MODAL_ACTION_ROW_SCROLL_PADDING as the Modal's className so focus scrolling
 * keeps controls above the footer.
 *
 * @param props.saving        - disables Save and shows the spinner
 * @param props.onSecondary - warning button handler (Reset All / Clear All)
 * @param props.secondaryLabel - already-translated warning button label
 * @param props.saveError   - shows the save-failed alert above the buttons
 */
export function ModalActionRow({
    onSave,
    saving,
    onSecondary,
    secondaryLabel,
    secondaryIcon = 'reset',
    onCancel,
    saveError = false,
}: {
    onSave: () => void | Promise<void>;
    saving: boolean;
    onSecondary: () => void | Promise<void>;
    secondaryLabel: string;
    secondaryIcon?: 'reset' | 'trash';
    onCancel: () => void;
    saveError?: boolean;
}) {
    const { t } = useTranslation();

    return (
        <div className="sticky -bottom-6 z-10 -mx-6 -mb-6 px-6 py-4 bg-base-100 border-t border-base-300">
            {saveError && (
                <div className="alert alert-error py-2 text-sm mb-2" role="alert">
                    <span>{t('app.settingsSaveError')}</span>
                </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
                <button
                    className="btn btn-latvian btn-sm"
                    onClick={() => void onSave()}
                    disabled={saving}
                    aria-busy={saving}
                >
                    {saving && <LoadingSpinner size="xs" decorative />}
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
        </div>
    );
}
