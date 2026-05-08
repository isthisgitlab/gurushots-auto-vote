import { useEffect } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useBoost } from '@/api/useBoost';
import { useTurbo } from '@/api/useTurbo';

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
    const { applyBoost, loading: boosting, error: boostError, clearError: clearBoostError } = useBoost();
    const { applyTurbo, loading: turboing, error: turboError, clearError: clearTurboError } = useTurbo();

    // entry.boost is an eligibility/availability indicator, not an
    // applied flag — the API uses a separate boolean entry.boosted
    // for that. Reading entry.boost here would light up the rocket
    // icon on entries that are merely *eligible* for boost.
    const isEntryBoosted = entry.boosted === true;
    const isEntryTurboed = !!entry.turbo;
    // Boost and turbo are mutually exclusive on a single entry —
    // applying one locks out the other on the same photo. Hide both
    // buttons whenever the entry is already in either state.
    const isEntryActioned = isEntryBoosted || isEntryTurboed;
    const showBoostButton = boostAvailable && !isEntryActioned;
    const showTurboButton = turboAvailable && !isEntryActioned;

    // Auto-clear errors after a few seconds so a stuck red button doesn't
    // block the user from retrying without page state reset.
    useEffect(() => {
        if (!boostError) return undefined;
        const id = setTimeout(clearBoostError, 5000);
        return () => clearTimeout(id);
    }, [boostError, clearBoostError]);
    useEffect(() => {
        if (!turboError) return undefined;
        const id = setTimeout(clearTurboError, 5000);
        return () => clearTimeout(id);
    }, [turboError, clearTurboError]);

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

    const handleBoost = async () => {
        const result = await applyBoost(challengeId, entry.id);
        if (result?.success && onBoostApplied) onBoostApplied();
    };

    const handleTurbo = async () => {
        const result = await applyTurbo(challengeId, entry.id);
        if (result?.success && onTurboApplied) onTurboApplied();
    };

    return (
        <div className={`badge badge-outline ${entryTypeClass} flex items-center gap-1`}>
            <span>{icon}</span>
            <span>
                {t('app.rank')} {entry.rank} ({entry.votes} {t('app.votes')})
            </span>
            {showBoostButton && (
                <button
                    className={`btn btn-xs ml-1 ${boostError ? 'btn-error' : 'btn-success'}`}
                    onClick={handleBoost}
                    disabled={boosting}
                    title={boostError || t('app.applyBoostToThisEntry')}
                >
                    {boosting ? <span className="loading loading-spinner loading-xs" /> : '🚀'}
                </button>
            )}
            {showTurboButton && (
                <button
                    className={`btn btn-xs ml-1 ${turboError ? 'btn-error' : 'btn-warning'}`}
                    onClick={handleTurbo}
                    disabled={turboing}
                    title={turboError || t('app.applyTurboToThisEntry')}
                >
                    {turboing ? <span className="loading loading-spinner loading-xs" /> : '⚡'}
                </button>
            )}
        </div>
    );
}
