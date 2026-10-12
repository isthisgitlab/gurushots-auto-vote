import { useState } from 'react';
import { ScenarioStatusLine } from './ScenarioStatusLine';
import { ScenarioResetModal } from './ScenarioResetModal';
import { refreshScenarioStatuses } from '@/api/useScenarioStatus';
import type * as useScenarioStatusModule from '@/api/useScenarioStatus';
import type { Challenge } from '../../../types/gurushots';

/**
 * A card's scenario status with the way to reset its progress: the status line, and the dialog its Reset button
 * opens. What the dialog resets is fixed when it opens (every challenge's progress when the saved progress cannot be
 * read, else this challenge's), and every card reads its status again afterwards.
 */
export function ScenarioStatusPanel({
    status,
    challenge,
}: {
    status: ReturnType<typeof useScenarioStatusModule.useScenarioStatus>;
    challenge: Pick<Challenge, 'id' | 'title' | 'url'>;
}) {
    const [resetting, setResetting] = useState<'one' | 'all' | null>(null);
    return (
        <>
            <ScenarioStatusLine
                status={status}
                onReset={() => setResetting(status?.corrupt === 'file' ? 'all' : 'one')}
            />
            <ScenarioResetModal
                challenge={resetting ? challenge : null}
                everyChallenge={resetting === 'all'}
                onClose={() => setResetting(null)}
                onChanged={refreshScenarioStatuses}
            />
        </>
    );
}
