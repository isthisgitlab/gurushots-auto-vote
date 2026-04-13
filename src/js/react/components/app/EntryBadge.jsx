import { useState, useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';

/**
 * Entry badge component showing entry details and boost button
 */
export function EntryBadge({ entry, challengeId, boostAvailable, onBoostApplied }) {
    const { t } = useTranslation();
    const [boosting, setBoosting] = useState(false);

    const isEntryBoosted = entry.boost === 1 || entry.boosted === true;
    const showBoostButton = boostAvailable && !isEntryBoosted;

    // Determine entry type and styling
    const getEntryStyle = () => {
        if (isEntryBoosted) {
            return { className: 'border-info text-info', icon: '🚀' };
        }
        if (entry.turbo) {
            return { className: 'border-warning text-warning', icon: '⚡' };
        }
        if (entry.guru_pick) {
            return { className: 'badge-secondary', icon: '⭐' };
        }
        // Regular entry
        return { className: 'border-success text-success', icon: '📷' };
    };

    const { className: entryTypeClass, icon } = getEntryStyle();

    const handleBoost = useCallback(async () => {
        setBoosting(true);
        try {
            const result = await window.api.applyBoost(challengeId, entry.id, 'boost');

            if (result?.success && onBoostApplied) {
                onBoostApplied();
            }
        } catch (err) {
            await window.api.logError(`Error applying boost: ${err.message || err}`);
        } finally {
            setBoosting(false);
        }
    }, [challengeId, entry.id, onBoostApplied]);

    return (
        <div className={`badge badge-outline ${entryTypeClass} flex items-center gap-1`}>
            <span>{icon}</span>
            <span>
                {t('app.rank')} {entry.rank} ({entry.votes} {t('app.votes')})
            </span>
            {showBoostButton && (
                <button
                    className="btn btn-xs btn-success ml-1"
                    onClick={handleBoost}
                    disabled={boosting}
                >
                    {boosting ? (
                        <span className="loading loading-spinner loading-xs" />
                    ) : (
                        '🚀'
                    )}
                </button>
            )}
        </div>
    );
}
