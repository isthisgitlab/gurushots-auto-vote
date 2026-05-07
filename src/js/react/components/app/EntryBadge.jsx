import { useState, useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';

/**
 * Entry badge component showing entry details and per-entry action buttons.
 *
 * @param {object} props
 * @param {object} props.entry           - Entry record from challenge.member.ranking.entries
 * @param {string|number} props.challengeId
 * @param {boolean} props.boostAvailable - Boost is currently usable on the parent challenge
 * @param {boolean} [props.turboAvailable] - A won Turbo is held and unapplied
 * @param {Function} [props.onBoostApplied]
 * @param {Function} [props.onTurboApplied]
 */
export function EntryBadge({ entry, challengeId, boostAvailable, turboAvailable, onBoostApplied, onTurboApplied }) {
    const { t } = useTranslation();
    const [boosting, setBoosting] = useState(false);
    const [turboing, setTurboing] = useState(false);

    const isEntryBoosted = entry.boost === 1 || entry.boosted === true;
    const isEntryTurboed = entry.turbo === 1 || entry.turbo === true;
    const showBoostButton = boostAvailable && !isEntryBoosted;
    const showTurboButton = turboAvailable && !isEntryTurboed;

    const getEntryStyle = () => {
        if (isEntryBoosted) {
            return { className: 'border-info text-info', icon: '🚀' };
        }
        if (isEntryTurboed) {
            return { className: 'border-warning text-warning', icon: '⚡' };
        }
        if (entry.guru_pick) {
            return { className: 'badge-secondary', icon: '⭐' };
        }
        return { className: 'border-success text-success', icon: '📷' };
    };

    const { className: entryTypeClass, icon } = getEntryStyle();

    const handleBoost = useCallback(async () => {
        setBoosting(true);
        try {
            const result = await window.api.applyBoost(challengeId, entry.id, 'boost');
            if (result?.success && onBoostApplied) onBoostApplied();
        } catch (err) {
            await window.api.logError(`Error applying boost: ${err.message || err}`);
        } finally {
            setBoosting(false);
        }
    }, [challengeId, entry.id, onBoostApplied]);

    const handleTurbo = useCallback(async () => {
        setTurboing(true);
        try {
            const result = await window.api.applyTurbo(challengeId, entry.id);
            if (result?.success && onTurboApplied) onTurboApplied();
        } catch (err) {
            await window.api.logError(`Error applying turbo: ${err.message || err}`);
        } finally {
            setTurboing(false);
        }
    }, [challengeId, entry.id, onTurboApplied]);

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
                    title={t('app.boost')}
                >
                    {boosting ? (
                        <span className="loading loading-spinner loading-xs" />
                    ) : (
                        '🚀'
                    )}
                </button>
            )}
            {showTurboButton && (
                <button
                    className="btn btn-xs btn-warning ml-1"
                    onClick={handleTurbo}
                    disabled={turboing}
                    title={t('app.turbo')}
                >
                    {turboing ? (
                        <span className="loading loading-spinner loading-xs" />
                    ) : (
                        '⚡'
                    )}
                </button>
            )}
        </div>
    );
}
