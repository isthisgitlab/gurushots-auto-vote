import { useTranslation } from '@/contexts/TranslationContext';
import { ConfirmModal } from './ConfirmModal';

/**
 * The question a settings modal asks when it is dismissed with edits that were not saved: keep editing, or throw
 * them away.
 *
 * @param props.onKeepEditing - closes the question and leaves the modal as it is
 * @param props.onDiscard - the user chose to lose the edits; the caller closes the modal
 */
export function UnsavedChangesModal({
    isOpen,
    onKeepEditing,
    onDiscard,
}: {
    isOpen: boolean;
    onKeepEditing: () => void;
    onDiscard: () => void;
}) {
    const { t } = useTranslation();
    return (
        <ConfirmModal
            isOpen={isOpen}
            title={t('app.settingsDiscardTitle')}
            working={false}
            problem={null}
            onClose={onKeepEditing}
            onConfirm={onDiscard}
            confirmLabel="app.settingsDiscard"
            cancelLabel="app.settingsKeepEditing"
            workingLabel="app.settingsDiscard"
        >
            <p>{t('app.settingsDiscardText')}</p>
        </ConfirmModal>
    );
}
