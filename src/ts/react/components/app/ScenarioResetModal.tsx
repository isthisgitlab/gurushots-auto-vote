import { useTranslation } from '@/contexts/TranslationContext';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { useConfirmedAction } from '@/hooks/useConfirmedAction';
import { interp } from '@/utils/interp';
import * as ipc from '@/api/ipc';

import type { Challenge } from '../../../types/gurushots';

// The text of each answer that resets nothing; a call that failed outright reads as the general one.
const PROBLEM_TEXT: Record<string, string> = {
    busy: 'app.scenarioResetBusy',
    'state-unreadable': 'app.scenarioResetUnreadable',
};

/**
 * Resets a challenge's scenario progress, after saying what that costs: the plan starts again, a spend that got no
 * answer can be spent again, and the spend counter restarts. When the saved progress cannot be read, the only reset
 * there is clears every challenge's, and the dialog says so.
 *
 * @param challenge - the card's challenge; null keeps the dialog closed
 * @param everyChallenge - the saved progress is unreadable: the reset is of every challenge
 * @param onReset - the progress is gone (the card reads its status again)
 */
export function ScenarioResetModal({
    challenge,
    everyChallenge,
    onClose,
    onReset,
}: {
    challenge: Pick<Challenge, 'id' | 'title'> | null;
    everyChallenge: boolean;
    onClose: () => void;
    onReset: () => void;
}) {
    const { t } = useTranslation();
    const { working, problem, run } = useConfirmedAction(challenge);

    const reset = (target: Pick<Challenge, 'id'>) =>
        run(async () => {
            const answer = await ipc.callOrNull(() =>
                everyChallenge ? ipc.resetAllScenarioState() : ipc.resetScenarioState(target.id),
            );
            if (!answer?.success) return PROBLEM_TEXT[answer?.error ?? ''] ?? 'app.scenarioResetFailed';
            onReset();
            onClose();
            return null;
        });

    return (
        <ConfirmModal
            isOpen={challenge !== null}
            title={t('app.scenarioResetTitle')}
            working={working}
            problem={problem}
            onClose={onClose}
            onConfirm={() => challenge && void reset(challenge)}
            confirmLabel="app.scenarioResetConfirm"
            workingLabel="app.scenarioResetWorking"
        >
            {challenge && (
                <p>
                    {everyChallenge
                        ? t('app.scenarioResetAllBody')
                        : interp(t('app.scenarioResetBody'), { title: challenge.title })}
                </p>
            )}
        </ConfirmModal>
    );
}
