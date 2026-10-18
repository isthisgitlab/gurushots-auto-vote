import { useTranslation } from '@/contexts/TranslationContext';
import { Modal, ModalActions } from './Modal';
import { ConfirmButton } from './ConfirmButton';
import type { ComponentChildren } from 'preact';

/**
 * A dialog that asks for confirmation of something destructive: its text (`children`), the problem the last attempt
 * left (an alert), Cancel, and a confirming button that stays focusable while the call is out. Nothing can dismiss
 * it while the call is out.
 *
 * @param title - the dialog's title
 * @param problem - translation key of the problem to show, or null
 * @param confirmLabel - translation key of the confirming button
 * @param cancelLabel - translation key of the Cancel button
 * @param workingLabel - translation key of the confirming button while the call is out
 */
export function ConfirmModal({
    isOpen,
    title,
    working,
    problem,
    onClose,
    onConfirm,
    confirmLabel,
    cancelLabel = 'app.cancel',
    workingLabel,
    children,
}: {
    isOpen: boolean;
    title: string;
    working: boolean;
    problem: string | null;
    onClose: () => void;
    onConfirm: () => void;
    confirmLabel: string;
    cancelLabel?: string;
    workingLabel: string;
    children?: ComponentChildren;
}) {
    const { t } = useTranslation();
    return (
        <Modal isOpen={isOpen} onClose={working ? undefined : onClose} title={title}>
            <div className="space-y-2 text-sm">
                {children}
                {problem && (
                    <p role="alert" className="text-error">
                        {t(problem)}
                    </p>
                )}
            </div>
            <ModalActions>
                <button className="btn btn-outline btn-sm" onClick={onClose} disabled={working}>
                    {t(cancelLabel)}
                </button>
                <ConfirmButton
                    working={working}
                    onConfirm={onConfirm}
                    label={confirmLabel}
                    workingLabel={workingLabel}
                />
            </ModalActions>
        </Modal>
    );
}
