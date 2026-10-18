import { useTranslation } from '@/contexts/TranslationContext';
import { LoadingSpinner } from './LoadingSpinner';
import { ResetIcon } from './ResetButton';
import { StickyModalFooter } from './StickyModalFooter';
import { StrokeIcon, ICON_PATHS } from './StrokeIcon';

const ROW_ICON_CLASS = 'w-4 h-4 mr-1';

/**
 * Shared secondary / Cancel / Save action row used by the settings modals
 * (SettingsModal and ChallengeSettingsModal), rendered in a StickyModalFooter:
 * the destructive button sits apart on the left, Cancel then Save on the right (the order every modal uses):
 * render it as the last child of the modal content, and pass
 * STICKY_FOOTER_SCROLL_PADDING as the hosting Modal's className.
 *
 * @param props.saving        - disables Save and shows the spinner
 * @param props.onSecondary - destructive button handler (Reset All / Clear All)
 * @param props.secondaryLabel - already-translated destructive button label
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
        <StickyModalFooter>
            {saveError && (
                <div className="alert alert-error py-2 text-sm" role="alert">
                    <span>{t('app.settingsSaveError')}</span>
                </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
                {/* Below sm the secondary takes the whole first row, so Cancel and Save wrap together onto the second. */}
                <div className="mr-auto max-sm:basis-full">
                    <button className="btn btn-error btn-sm" onClick={() => void onSecondary()}>
                        {secondaryIcon === 'trash' ? (
                            <StrokeIcon d={ICON_PATHS.trash} className={ROW_ICON_CLASS} />
                        ) : (
                            <ResetIcon className={ROW_ICON_CLASS} />
                        )}
                        {secondaryLabel}
                    </button>
                </div>
                <button className="btn btn-outline btn-sm" onClick={onCancel}>
                    {t('app.cancel')}
                </button>
                <button
                    className="btn btn-neutral btn-sm"
                    onClick={() => void onSave()}
                    disabled={saving}
                    aria-busy={saving}
                >
                    {saving && <LoadingSpinner size="xs" decorative />}
                    <StrokeIcon d={ICON_PATHS.save} className={ROW_ICON_CLASS} />
                    {t('app.save')}
                </button>
            </div>
        </StickyModalFooter>
    );
}
