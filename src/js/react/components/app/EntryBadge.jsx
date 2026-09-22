import { useTranslation } from '@/contexts/TranslationContext';
import { useBoost } from '@/api/useBoost';
import { useTurbo } from '@/api/useTurbo';
import { useAutoClear } from '@/hooks/useAutoClear';
import { getEntryStatus } from '@/utils/formatters';
import { EntryPhoto } from './EntryPhoto';

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

    // Shared with the compact card's glyph row so both read one mapping.
    const {
        isBoosted: isEntryBoosted,
        isTurboed: isEntryTurboed,
        className: entryTypeClass,
        icon,
    } = getEntryStatus(entry);
    // Boost and turbo are mutually exclusive on a single entry —
    // applying one locks out the other on the same photo. Hide both
    // buttons whenever the entry is already in either state.
    const isEntryActioned = isEntryBoosted || isEntryTurboed;
    const showBoostButton = boostAvailable && !isEntryActioned;
    const showTurboButton = turboAvailable && !isEntryActioned;

    // Auto-clear errors after a few seconds so a stuck red button doesn't
    // block the user from retrying without page state reset.
    useAutoClear(boostError, clearBoostError, 5000);
    useAutoClear(turboError, clearTurboError, 5000);

    const handleBoost = async () => {
        const result = await applyBoost(challengeId, entry.id);
        if (result?.success && onBoostApplied) onBoostApplied();
    };

    const handleTurbo = async () => {
        const result = await applyTurbo(challengeId, entry.id);
        if (result?.success && onTurboApplied) onTurboApplied();
    };

    return (
        // h-auto + py-1: a stock DaisyUI badge is ~20px tall, which would clip
        // the thumbnail. Growing the badge keeps the chip, the text and the
        // action buttons on one baseline.
        <div className={`badge badge-outline ${entryTypeClass} flex h-auto items-center gap-1 py-1`}>
            <EntryPhoto entry={entry} />
            <span>{icon}</span>
            <span>
                {t('app.rank')} {entry.rank} ({entry.votes} {t('app.votes')})
            </span>
            {showBoostButton && (
                <button
                    className={`btn btn-xs ml-1 ${boostError ? 'btn-error' : 'btn-success'}`}
                    onClick={handleBoost}
                    disabled={boosting}
                >
                    {boosting ? <span className="loading loading-spinner loading-xs" /> : `🚀 ${t('app.boost')}`}
                </button>
            )}
            {showTurboButton && (
                <button
                    className={`btn btn-xs ml-1 ${turboError ? 'btn-error' : 'btn-warning'}`}
                    onClick={handleTurbo}
                    disabled={turboing}
                >
                    {turboing ? <span className="loading loading-spinner loading-xs" /> : `⚡ ${t('app.turbo')}`}
                </button>
            )}
            {(boostError || turboError) && <span className="text-error ml-1">{boostError || turboError}</span>}
        </div>
    );
}
