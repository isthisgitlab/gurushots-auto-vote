/**
 * The chooser's footer with Clear, Cancel and Save, and the error of a save that failed. The picker's
 * own controls (search, Load all, Auto) live in PhotoPickerToolbar.
 */

import { useTranslation } from '@/contexts/TranslationContext';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

/**
 * Clear (apart on the left), Cancel and Save (rightmost).
 */
export function ChooserFooter({
    saveFailed,
    saving,
    onSave,
    onClear,
    onClose,
}: {
    saveFailed: boolean;
    saving: boolean;
    onSave: () => void;
    onClear: () => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    return (
        <>
            {saveFailed && (
                <div role="alert" className="alert alert-error py-2 text-sm">
                    <span>{t('app.photoChooserSaveError')}</span>
                </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
                {/* Below sm Clear takes the whole first row, so Cancel and Save wrap together onto the second. */}
                <button type="button" className="btn btn-error btn-sm mr-auto max-sm:basis-full" onClick={onClear}>
                    {t('app.photosClear')}
                </button>
                <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>
                    {t('app.cancel')}
                </button>
                <button type="button" className="btn btn-neutral btn-sm" disabled={saving} onClick={onSave}>
                    {saving && <LoadingSpinner size="xs" decorative />}
                    {t('app.photoChooserUse')}
                </button>
            </div>
        </>
    );
}
