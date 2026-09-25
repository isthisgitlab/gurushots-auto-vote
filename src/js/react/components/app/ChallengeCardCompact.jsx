import { useTranslation } from '@/contexts/TranslationContext';
import { getEntryStatus } from '@/utils/formatters';
import { ChallengeBadgeRow } from './ChallengeBadgeRow';
import { CardDensityToggle } from './CardDensityToggle';
import { DeadlineTimeline } from './DeadlineTimeline';
import { ScenarioStatusLine } from './ScenarioStatusLine';

/**
 * One labelled stat in the compact tile's grid. The emoji is the visual label;
 * the translated name rides on `title` so the cell stays one short line.
 */
function Stat({ icon, label, className = '', children }) {
    return (
        <div className={`truncate ${className}`} title={label}>
            <span aria-hidden="true">{icon}</span> <span className="sr-only">{label}: </span>
            {children}
        </div>
    );
}

/**
 * Compact challenge tile — a summary of state (time, exposure, rank,
 * boost/turbo, entries and each entry's boost/turbo mark). By default it offers
 * no actions and the density toggle is its only control. With the
 * compactCardActions setting on, the parent passes `actions`: a footer row of
 * the challenge-level actions (vote, run, earn turbo, submit, currency spends,
 * settings). Per-entry actions (boost/turbo placement, swap, photo preview)
 * stay in the detailed card either way.
 *
 * Several tiles share a grid row (see ChallengesSection), so everything is
 * sized for a ~16rem column: one truncating title line, a 2-column stat grid.
 *
 * All values are derived by the parent ChallengeCard and passed in, so the
 * tile and the detailed card can never disagree about what a state means.
 */
export function ChallengeCardCompact({
    challenge,
    badgeRowProps,
    timeText,
    exposureFactor,
    exposureClass,
    boostStatus,
    turboStatus,
    entries,
    hasCompactOverride,
    onToggleCompact,
    boostBlocked,
    deadlineActions,
    scenarioStatus,
    actions,
}) {
    const { t } = useTranslation();
    const progress = challenge.member.ranking.total;
    const hasRank = progress?.rank > 0;

    return (
        <div className="space-y-2">
            <div>
                <div className="flex items-start gap-1">
                    <h3 className="font-bold text-sm truncate flex-1 min-w-0" title={challenge.title}>
                        {challenge.title}
                    </h3>
                    <CardDensityToggle isCompact hasOverride={hasCompactOverride} onToggle={onToggleCompact} />
                </div>
                <ChallengeBadgeRow {...badgeRowProps} showPhotoCount={false} />
            </div>

            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-base-content/80">
                <Stat
                    icon="⏱"
                    label={t('app.time')}
                    className={timeText === 'Ended' ? 'text-error font-medium' : 'text-success font-medium'}
                >
                    {timeText}
                </Stat>
                <Stat icon="📊" label={t('app.exposure')} className={exposureClass}>
                    {exposureFactor}%
                </Stat>
                <Stat icon="🏆" label={t('app.rank')}>
                    {hasRank ? `${progress.rank.toLocaleString()} / ${challenge.players.toLocaleString()}` : '—'}
                </Stat>
                <Stat icon="🖼" label={t('app.yourEntries')}>
                    {entries.length}/{challenge.max_photo_submits}
                </Stat>
                <Stat icon="🚀" label={t('app.boost')} className={boostStatus.colorClass}>
                    {boostStatus.text}
                </Stat>
                <Stat icon="⚡" label={t('app.turbo')} className={turboStatus.colorClass}>
                    {turboStatus.text}
                </Stat>
            </div>

            {/* Per-entry state as glyphs: which photo is boosted / turboed /
                guru-picked, and its rank. No thumbnail, no buttons. */}
            {entries.length > 0 && (
                <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs" aria-label={t('app.entryDetails')}>
                    {entries.map((entry) => {
                        const { icon, textClass } = getEntryStatus(entry);
                        return (
                            <span
                                key={entry.id}
                                className={textClass}
                                title={`${t('app.rank')} ${entry.rank} (${entry.votes} ${t('app.votes')})`}
                            >
                                {icon} #{entry.rank}
                            </span>
                        );
                    })}
                </div>
            )}

            {/* Boost/turbo conflict is state worth seeing even in the tile —
                a one-line note instead of the detailed card's alert box. */}
            {boostBlocked && (
                <div className="text-xs text-warning line-clamp-2" role="alert">
                    ⚠ {t('app.boostConflictWarning')}
                </div>
            )}

            <DeadlineTimeline actions={deadlineActions} compact />
            <ScenarioStatusLine status={scenarioStatus} compact />

            {actions}
        </div>
    );
}
