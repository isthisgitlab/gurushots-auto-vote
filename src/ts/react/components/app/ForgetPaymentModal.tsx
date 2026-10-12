import { useEffect, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useCoinsNow } from '@/api/useCoinsNow';
import { Modal, ModalActions } from '@/components/ui/Modal';
import { interp } from '@/utils/interp';
import * as ipc from '@/api/ipc';

import type { OpenChallenge } from '../../../types/gurushots';

// The text of each answer that forgets nothing; anything else (and a call that failed) reads as the general one.
const PROBLEM_TEXT: Record<string, string> = {
    'nothing-to-forget': 'app.discoverForgetNothing',
    'account-unknown': 'app.discoverForgetAccountUnknown',
    'other-account-possible': 'app.discoverForgetOtherAccount',
};

/**
 * What the user can compare with the coin history on GuruShots: the balance recorded just before the payment, and
 * the one now when it could be read. The app does not decide from them whether the payment went through.
 */
function BalanceHint({ before, now }: { before: number; now: number | null }) {
    const { t } = useTranslation();
    return (
        <p className="text-base-content/70">
            {now === null
                ? interp(t('app.discoverForgetBalanceBefore'), { before })
                : interp(t('app.discoverForgetBalances'), { before, now })}
        </p>
    );
}

/**
 * The user's way out of a payment that could not be confirmed: after checking GuruShots shows the coins were not
 * taken, confirming forgets the saved payment, so the row's next Join asks for the price as for any first join.
 * Nothing here spends anything; a payment known to have been taken cannot be forgotten (the answer says so).
 *
 * @param challenge - the row being forgotten; null keeps the dialog closed
 * @param coinsBefore - the balance recorded just before the payment, when there is one
 * @param onForgotten - the payment of that challenge id is gone
 */
export function ForgetPaymentModal({
    challenge,
    coinsBefore,
    onClose,
    onForgotten,
}: {
    challenge: OpenChallenge | null;
    coinsBefore?: number;
    onClose: () => void;
    onForgotten: (id: OpenChallenge['id']) => void;
}) {
    const { t } = useTranslation();
    const [working, setWorking] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const coinsNow = useCoinsNow(challenge !== null && coinsBefore !== undefined);

    // A problem from an earlier opening never shows in a later one: it goes whenever the dialog opens or closes.
    useEffect(() => setProblem(null), [challenge]);

    const forget = async (target: OpenChallenge) => {
        setWorking(true);
        try {
            const answer = await ipc.callOrNull(() => ipc.forgetUnconfirmedPayment(target.id));
            if (answer?.success) {
                onForgotten(target.id);
                onClose();
            } else {
                const reported = answer && 'error' in answer && typeof answer.error === 'string' ? answer.error : '';
                setProblem(PROBLEM_TEXT[reported] ?? 'app.discoverForgetFailed');
            }
        } finally {
            setWorking(false);
        }
    };

    return (
        <Modal isOpen={challenge !== null} onClose={working ? undefined : onClose} title={t('app.discoverForgetTitle')}>
            {challenge && (
                <>
                    <div className="space-y-2 text-sm">
                        <p>{interp(t('app.discoverForgetBody'), { title: challenge.title || challenge.url })}</p>
                        {coinsBefore !== undefined && <BalanceHint before={coinsBefore} now={coinsNow} />}
                        {problem && (
                            <p role="alert" className="text-error">
                                {t(problem)}
                            </p>
                        )}
                    </div>
                    <ModalActions>
                        <button className="btn btn-outline btn-sm" onClick={onClose} disabled={working}>
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
