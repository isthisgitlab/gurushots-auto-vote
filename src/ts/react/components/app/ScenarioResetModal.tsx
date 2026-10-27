import { useTranslation } from '@/contexts/TranslationContext';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { useConfirmedAction } from '@/hooks/useConfirmedAction';
import * as ipc from '@/api/ipc';

import type { Challenge } from '../../../types/gurushots';

// The text of each answer that resets nothing; a call that failed outright reads as the general one.
const problemOf = (error: string | undefined, everyChallenge: boolean): string => {
    if (error === 'busy') return everyChallenge ? 'app.scenarioResetAllBusy' : 'app.scenarioResetBusy';
    if (error === 'locks-unavailable') return 'app.locksUnavailable';
    if (error === 'state-unreadable') return 'app.scenarioResetUnreadable';
    if (error === 'state-unloaded') return 'app.scenarioResetUnloaded';
    if (error === 'state-readable') return 'app.scenarioResetReadable';
    if (error === 'not-saved') return everyChallenge ? 'app.scenarioResetAllNotSaved' : 'app.scenarioResetNotSaved';
    return everyChallenge ? 'app.scenarioResetAllFailed' : 'app.scenarioResetFailed';
};

/**
 * Resets a challenge's scenario progress, after saying what that costs: the plan starts again, a spend that got no
 * answer can be spent again, and the spend counter restarts. When the saved progress cannot be read, the only reset
 * there is clears every challenge's, and the dialog says so.
 *
 * @param challenge - the card's challenge; null keeps the dialog closed
 * @param everyChallenge - the saved progress is unreadable: the reset is of every challenge
 * @param onChanged - what the card shows is out of date (the progress is gone, or turned out to be unreadable): every
 *   card reads its status again
 */
export function ScenarioResetModal({
    challenge,
    everyChallenge,
    onClose,
    onChanged,
}: {
    challenge: Pick<Challenge, 'id' | 'title' | 'url'> | null;
    everyChallenge: boolean;
    onClose: () => void;
    onChanged: () => void;
}) {
    const { t } = useTranslation();
    const { working, problem, run } = useConfirmedAction(challenge);

    const reset = (target: Pick<Challenge, 'id'>) =>
        run(async () => {
            const answer = await ipc.callOrNull(() =>
                everyChallenge ? ipc.resetAllScenarioState(true) : ipc.resetScenarioState(target.id),
            );
            const error = answer?.success ? undefined : answer?.error;
            // The file turned out unreadable since the card read it: the card learns, and offers the right reset.
            if (!answer?.success) {
                if (error === 'state-unreadable' || error === 'state-readable' || error === 'state-unloaded')
                    onChanged();
                return problemOf(error, everyChallenge);
            }
            onChanged();
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
                        : t('app.scenarioResetBody', { title: challenge.title || challenge.url })}
                </p>
            )}
        </ConfirmModal>
    );
}
