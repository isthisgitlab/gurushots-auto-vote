import { useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { Modal, ModalActions } from '@/components/ui/Modal';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { announceChosenPhotosCleared } from '@/api/chosenPhotosCleared';
import * as ipc from '@/api/ipc';

/**
 * The notice shown while the list the chooser opened with was saved under
 * another account: what that means, and the way to remove those lists — behind a
 * confirmation, since it reaches every setting, profile, rule and scenario.
 */
export function OtherAccountNotice({ onRemoved }: { onRemoved: () => void }) {
    const { t } = useTranslation();
    const [confirming, setConfirming] = useState(false);
    const [removing, setRemoving] = useState(false);
    const [failed, setFailed] = useState(false);

    const remove = async () => {
        setRemoving(true);
        setFailed(false);
        const result = await ipc.callOrNull(() => ipc.clearChosenPhotos());
        setRemoving(false);
        setConfirming(false);
        if (result?.success) {
            // Every open editor drops its copy of the lists, so saving it cannot put them back.
            announceChosenPhotosCleared();
            onRemoved();
        } else setFailed(true);
    };

    return (
        <>
            <div role="alert" className="alert alert-warning py-2 text-sm">
                <span className="flex-1">{t('app.photoChooserOtherAccount')}</span>
                <button type="button" className="btn btn-sm" onClick={() => setConfirming(true)}>
                    {t('app.photoChooserOtherAccountClear')}
                </button>
            </div>
            {failed && (
                <div role="alert" className="alert alert-error py-2 text-sm">
                    <span>{t('app.photoChooserOtherAccountClearError')}</span>
                </div>
            )}
            <Modal
                isOpen={confirming}
                onClose={removing ? undefined : () => setConfirming(false)}
                title={t('app.photoChooserOtherAccountClear')}
                showCloseButton={!removing}
            >
                <p className="text-sm">{t('app.photoChooserOtherAccountConfirm')}</p>
                <ModalActions>
                    <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        disabled={removing}
                        onClick={() => setConfirming(false)}
                    >
                        {t('app.cancel')}
                    </button>
                    <button
                        type="button"
                        className="btn btn-error btn-sm"
                        disabled={removing}
                        onClick={() => void remove()}
                    >
                        {removing && <LoadingSpinner size="xs" decorative />}
                        {t('app.photoChooserOtherAccountClear')}
                    </button>
                </ModalActions>
            </Modal>
        </>
    );
}
