import { useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { Modal, ModalActions } from '@/components/ui/Modal';
import { interp } from '@/utils/interp';
import * as ipc from '@/api/ipc';

import type { OpenChallenge } from '../../../types/gurushots';

/**
 * The user's way out of a payment that could not be confirmed: after checking GuruShots shows the coins were not
 * taken, confirming forgets the saved payment, so the row's next Join asks for the price as for any first join.
 * Nothing here spends anything; a payment known to have been taken cannot be forgotten (the answer says so).
 *
 * @param challenge - the row being forgotten; null keeps the dialog closed
 * @param onForgotten - the payment of that challenge id is gone
 */
export function ForgetPaymentModal({
    challenge,
    onClose,
    onForgotten,
}: {
    challenge: OpenChallenge | null;
    onClose: () => void;
    onForgotten: (id: OpenChallenge['id']) => void;
}) {
    const { t } = useTranslation();
    const [working, setWorking] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);

    const close = () => {
        setProblem(null);
        onClose();
    };

    const forget = async (target: OpenChallenge) => {
        setWorking(true);
        try {
            const answer = await ipc.forgetUnconfirmedPayment(target.id);
            if (answer.success) {
                onForgotten(target.id);
                close();
            } else {
                setProblem(
                    answer.error === 'nothing-to-forget' ? 'app.discoverForgetNothing' : 'app.discoverForgetFailed',
                );
            }
        } finally {
            setWorking(false);
        }
    };

    return (
        <Modal isOpen={challenge !== null} onClose={close} title={t('app.discoverForgetTitle')}>
            {challenge && (
                <>
                    <div className="space-y-2 text-sm">
                        <p>{interp(t('app.discoverForgetBody'), { title: challenge.title || challenge.url })}</p>
                        {problem && (
                            <p role="alert" className="text-error">
                                {t(problem)}
                            </p>
                        )}
                    </div>
                    <ModalActions>
                        <button className="btn btn-outline btn-sm" onClick={close}>
                            {t('app.cancel')}
                        </button>
                        <button
                            className="btn btn-warning btn-sm"
                            onClick={() => void forget(challenge)}
                            disabled={working}
                        >
                            {t('app.discoverForgetConfirm')}
                        </button>
                    </ModalActions>
                </>
            )}
        </Modal>
    );
}
