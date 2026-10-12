import { useState } from 'react';
import { ScenarioStatusLine } from './ScenarioStatusLine';
import { ScenarioResetModal } from './ScenarioResetModal';
import type * as useScenarioStatusModule from '@/api/useScenarioStatus';
import type { Challenge } from '../../../types/gurushots';

/**
 * A card's scenario status with the way to reset its progress: the status line, and the dialog its Reset button
 * opens (for every challenge when the saved progress cannot be read).
 *
 * @param onReset - the progress was reset: the card reads its status again
 */
export function ScenarioStatusPanel({
    status,
    challenge,
    onReset,
}: {
    status: ReturnType<typeof useScenarioStatusModule.useScenarioStatus>;
    challenge: Pick<Challenge, 'id' | 'title'>;
    onReset: () => void;
}) {
    const [resetting, setResetting] = useState(false);
    return (
        <>
            <ScenarioStatusLine status={status} onReset={() => setResetting(true)} />
            <ScenarioResetModal
                challenge={resetting ? challenge : null}
                everyChallenge={Boolean(status?.corrupt)}
                onClose={() => setResetting(false)}
                onReset={onReset}
            />
        </>
    );
}
