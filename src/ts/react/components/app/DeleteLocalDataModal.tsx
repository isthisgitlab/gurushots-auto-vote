import { useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { usePlatformCapabilities } from '@/api/usePlatformCapabilities';
import { Modal, ModalActions } from '@/components/ui/Modal';
import { BusyContent } from '@/components/ui/LoadingSpinner';
import * as ipc from '@/api/ipc';
import { errorMessage } from '../../../errorMessage';

type Outcome = 'idle' | 'busy-app' | 'failed' | 'done';

const OUTCOME_KEYS = {
    'busy-app': 'about.deleteBusy',
    failed: 'about.deleteFailed',
    done: 'about.deleteDone',
} as const;

/**
 * Confirms and runs "Delete all local data". It lists what goes (the background service state only on Android),
 * and starts with focus on Cancel — Cancel is the first control and there is no close button, so nothing is
 * deleted by a stray Enter. While the delete runs the dialog cannot be dismissed. A refusal because a voting pass is
 * running, or a failure, is worded for the user and stays on screen; on success the shell relaunches the app.
 */
export function DeleteLocalDataModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const { backgroundService } = usePlatformCapabilities();
    const [deleting, setDeleting] = useState(false);
    const [outcome, setOutcome] = useState<Outcome>('idle');

    const handleDelete = async () => {
        setDeleting(true);
        setOutcome('idle');
        try {
            const result = await ipc.wipeLocalData();
            if (result?.success) {
                setOutcome('done');
            } else if (result?.error === 'busy') {
                setOutcome('busy-app');
            } else {
                void ipc.logRendererError(`Deleting the local data failed: ${result?.error ?? 'no answer'}`);
                setOutcome('failed');
            }
        } catch (err) {
            void ipc.logRendererError(`Deleting the local data threw: ${errorMessage(err) || err}`);
            setOutcome('failed');
        } finally {
            setDeleting(false);
        }
    };

    const handleClose = () => {
        setOutcome('idle');
        onClose();
    };

    const done = outcome === 'done';
    const label = t('about.deleteConfirm');
    return (
        <Modal
            isOpen={isOpen}
            onClose={deleting ? undefined : handleClose}
            title={t('about.deleteTitle')}
            size="md"
            showCloseButton={false}
        >
            <div className="space-y-3 text-sm">
                <p>{t('about.deleteIntro')}</p>
                <ul className="list-disc ml-5">
                    <li>{t('about.deleteLogin')}</li>
                    <li>{t('about.deleteSettings')}</li>
                    <li>{t('about.deleteProfiles')}</li>
                    <li>{t('about.deleteScenarios')}</li>
                    <li>{t('about.deleteStats')}</li>
                    <li>{t('about.deleteLogs')}</li>
                    {backgroundService && <li>{t('about.deleteBackground')}</li>}
                </ul>
                <p>{t('about.deleteAfter')}</p>
                {outcome !== 'idle' && (
                    <div
                        role={done ? 'status' : 'alert'}
                        className={`alert ${done ? 'alert-success' : 'alert-error'} py-2 text-sm`}
                    >
                        <span>{t(OUTCOME_KEYS[outcome])}</span>
                    </div>
                )}
            </div>
            <ModalActions>
                <button type="button" className="btn btn-outline btn-sm" onClick={handleClose} disabled={deleting}>
                    {done ? t('common.closeModal') : t('app.cancel')}
                </button>
                {!done && (
                    <button
                        type="button"
                        className="btn btn-error btn-sm"
                        onClick={() => void handleDelete()}
                        disabled={deleting}
                        aria-busy={deleting}
                    >
                        <BusyContent busy={deleting} label={label} />
                    </button>
                )}
            </ModalActions>
        </Modal>
    );
}
