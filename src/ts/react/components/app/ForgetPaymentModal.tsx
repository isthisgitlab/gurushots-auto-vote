import { useTranslation } from '@/contexts/TranslationContext';
import { useCoinsNow } from '@/api/useCoinsNow';
import { usePlatformCapabilities } from '@/api/usePlatformCapabilities';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { useConfirmedAction } from '@/hooks/useConfirmedAction';
import * as ipc from '@/api/ipc';

import type { OpenChallenge } from '../../../types/gurushots';
import type { ForgetStatus } from '../../../types/join';

// The text of each answer that forgets nothing; a call that failed outright, or an answer with no status, reads as
// the general one.
const PROBLEM_TEXT: Record<Exclude<ForgetStatus, 'forgotten'>, string> = {
    'nothing-to-forget': 'app.discoverForgetNothing',
    busy: 'app.discoverForgetBusy',
    unreadable: 'app.discoverForgetUnreadable',
    'locks-unavailable': 'app.locksUnavailable',
    'not-authenticated': 'app.discoverForgetNotAuthenticated',
};

// On Android the join state is not a file the user can reach: the next step differs.
const problemOf = (
    answer: Awaited<ReturnType<typeof ipc.forgetUnconfirmedPayment>> | null,
    settingsFile: boolean,
): string => {
    const reported = answer && 'status' in answer ? answer.status : 'forgotten';
    if (reported === 'unreadable' && !settingsFile) return 'app.discoverForgetUnreadableAndroid';
    return reported === 'forgotten' ? 'app.discoverForgetFailed' : PROBLEM_TEXT[reported];
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
                ? t('app.discoverForgetBalanceBefore', { before })
                : t('app.discoverForgetBalances', { before, now })}
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
    const { working, problem, run } = useConfirmedAction(challenge);
    const { settingsFile } = usePlatformCapabilities();
    const coinsNow = useCoinsNow(challenge !== null && coinsBefore !== undefined);

    const forget = (target: OpenChallenge) =>
        run(async () => {
            const answer = await ipc.callOrNull(() => ipc.forgetUnconfirmedPayment(target.id));
            if (!answer?.success) return problemOf(answer, settingsFile);
            onForgotten(target.id);
            onClose();
            return null;
        });

    return (
        <ConfirmModal
            isOpen={challenge !== null}
            title={t('app.discoverForgetTitle')}
            working={working}
            problem={problem}
            onClose={onClose}
            onConfirm={() => challenge && void forget(challenge)}
            confirmLabel="app.discoverForgetConfirm"
            workingLabel="app.discoverForgetWorking"
        >
            {challenge && (
                <>
                    <p>{t('app.discoverForgetBody', { title: challenge.title || challenge.url })}</p>
                    {coinsBefore !== undefined && <BalanceHint before={coinsBefore} now={coinsNow} />}
                </>
            )}
        </ConfirmModal>
    );
}
