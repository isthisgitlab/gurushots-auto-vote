import { useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { usePlatformCapabilities } from '@/api/usePlatformCapabilities';
import { Modal, ModalActions } from '@/components/ui/Modal';
import { BusyContent } from '@/components/ui/LoadingSpinner';
import * as ipc from '@/api/ipc';
import { errorMessage } from '../../../errorMessage';

type Busy = 'busy-pass' | 'busy-cli' | 'busy-app';
type Outcome = 'idle' | Busy | 'failed' | 'done';

// Each refusal names what is in the way and the one step that clears it.
const BUSY_KEYS: Record<Busy, string> = {
    'busy-pass': 'about.deleteBusyPass',
    'busy-cli': 'about.deleteBusyCli',
    'busy-app': 'about.deleteBusyApp',
};
const isBusy = (error: unknown): error is Busy => typeof error === 'string' && Object.hasOwn(BUSY_KEYS, error);

/**
 * Confirms and runs "Delete all local data". It lists what goes (the background service state only on Android),
 * and starts with focus on Cancel — Cancel is the first control and there is no close button, so nothing is
 * deleted by a stray Enter. While the delete runs the dialog cannot be dismissed. A refusal (a voting pass, a command-line
 * session or the desktop app is in the way) or a failure is worded for the user and stays on screen (a failure that left the
 * window's caches emptied reloads it when the dialog is closed); on success the
 * shell relaunches the app, or, where it cannot (the web shell's server stops), the text says to start it again.
 */
export function DeleteLocalDataModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const { backgroundService, relaunchesAfterWipe } = usePlatformCapabilities();
    const [deleting, setDeleting] = useState(false);
    const [outcome, setOutcome] = useState<Outcome>('idle');
    // A failed delete may have emptied the window's caches: the window reloads when the dialog is closed, and stays
    // set through a retry, since an earlier attempt's damage is still there.
    const reloadOnClose = useRef(false);

    const handleDelete = async () => {
        setDeleting(true);
        setOutcome('idle');
        try {
            const result = await ipc.wipeLocalData();
            if (result?.success) {
                // The wipe went through: the app restarts, and no reload is wanted on top of that.
                reloadOnClose.current = false;
                setOutcome('done');
            } else if (isBusy(result?.error)) {
                setOutcome(result.error);
            } else {
                void ipc.logRendererError(`Deleting the local data failed: ${result?.error ?? 'no answer'}`);
                reloadOnClose.current ||= result?.success === false && result.reload === true;
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
        if (reloadOnClose.current) {
            reloadOnClose.current = false;
            void ipc.reloadWindow();
        }
    };

    const done = outcome === 'done';
    const outcomeKey = (() => {
        if (outcome === 'idle') return null;
        if (outcome === 'done') return relaunchesAfterWipe ? 'about.deleteDone' : 'about.deleteDoneWeb';
        if (outcome === 'failed') return backgroundService ? 'about.deleteFailedAndroid' : 'about.deleteFailed';
        return BUSY_KEYS[outcome];
    })();
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
                <p>{t(relaunchesAfterWipe ? 'about.deleteAfter' : 'about.deleteAfterWeb')}</p>
                {outcomeKey && (
                    <div
                        role={done ? 'status' : 'alert'}
                        className={`alert ${done ? 'alert-success' : 'alert-error'} py-2 text-sm`}
                    >
                        <span>{t(outcomeKey)}</span>
                    </div>
                )}
            </div>
            <ModalActions>
                <button type="button" className="btn btn-outline btn-sm" onClick={handleClose} disabled={deleting}>
                    {done ? t('app.close') : t('app.cancel')}
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
