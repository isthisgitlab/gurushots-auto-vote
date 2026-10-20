import type { ComponentChildren } from 'preact';
import type { Challenge } from '../../../types/gurushots';
import { useTranslation } from '@/contexts/TranslationContext';
import { useCustomizedChallengeIds } from '@/hooks/useCustomizedChallengeIds';
import type { CustomizationKind } from '@/hooks/useCustomizedChallengeIds';
import { ChipListPanel, ChallengeChip, ChipTitle } from './ChallengeChips';
import { PulseDot } from '../ui/PulseDot';
import { isBoostWindowOpen } from '../../../voting/boostWindow';
import { isLowExposure } from '@/utils/challengeAlerts';
import { chipToneOf } from '@/utils/customizationTone';

/** What a customization kind means for a chip: manual overrides, an automatic profile, rule values alone. */
const customizationOf = (kind: CustomizationKind | undefined) => ({
    manual: kind === 'manual' || kind === 'both',
    automatic: kind === 'profile' || kind === 'both',
    byRule: kind === 'rule',
});

/**
 * A status dot on its chip. On a coloured chip it gets a ring in the page colour, so a red or blue dot stays visible
 * against any fill; a neutral chip's dot stands as it is. The ring takes the theme's selector radius, like the
 * dot's own `.status`, so a square-selector theme gets no corners poking out of a round ring.
 */
function ChipDot({ ringed, children }: { ringed: boolean; children: ComponentChildren }) {
    if (!ringed) return <>{children}</>;
    return <span className="inline-flex rounded-selector ring-2 ring-base-100">{children}</span>;
}

/** One challenge's chip: its title, the status dots, a "T" badge on a team match and the marker of what customizes it. */
function NavChip({
    challenge: c,
    kind,
    nowSec,
}: {
    challenge: Challenge;
    kind: CustomizationKind | undefined;
    nowSec: number;
}) {
    const { t } = useTranslation();
    const { manual, automatic, byRule } = customizationOf(kind);
    const hint = [
        c?.teamMatch && t('app.teamChallenge'),
        manual && t('app.customSettingsHint'),
        automatic && t('app.titleRuleProfile'),
        byRule && t('app.ruleSettingsHint'),
    ]
        .filter(Boolean)
        .join(' · ');
    const boostOpen = isBoostWindowOpen(c?.member?.boost, nowSec);
    const lowExposure = isLowExposure(c, nowSec);
    const tone = chipToneOf(kind);
    return (
        <ChallengeChip challengeId={c?.id} className={tone}>
            {boostOpen && (
                <ChipDot ringed={tone !== ''}>
                    <PulseDot variant="info" size="status-sm" onBadge={automatic} />
                </ChipDot>
            )}
            {lowExposure && (
                <ChipDot ringed={tone !== ''}>
                    <PulseDot variant="error" pulse={false} size="status-sm" />
                </ChipDot>
            )}
            {c?.teamMatch && (
                <span aria-hidden="true" className="badge badge-xs badge-primary mr-1">
                    T
                </span>
            )}
            {manual && <span aria-hidden="true">⚙️ </span>}
            {automatic && <span aria-hidden="true">🔄 </span>}
            {byRule && <span aria-hidden="true">📏 </span>}
            <ChipTitle hint={hint}>{c?.title}</ChipTitle>
            {boostOpen && <span className="sr-only"> ({t('app.boostOpenBadge')})</span>}
            {lowExposure && <span className="sr-only"> ({t('app.lowExposure')})</span>}
            {hint && <span className="sr-only"> ({hint})</span>}
        </ChallengeChip>
    );
}

/**
 * "Jump to challenge" index placed above the challenge list. Lists every active
 * challenge by title in the same order the cards render; each entry is a button
 * that smooth-scrolls to the matching ChallengeCard (id="challenge-<id>"), so a
 * user who knows the name can click instead of scrolling. Renders nothing when
 * there are no challenges. Mirrors BoostWindowBanner, but for the full list.
 *
 * Manual overrides get an accent fill and ⚙️; automatic profiles get an info fill and 🔄
 * (a challenge with both shows both icons on the info fill). Values a rule sets directly
 * that matter after the join (and nothing else) get a secondary fill and 📏. The icons and
 * tooltip identify the source without relying on colour alone (utils/customizationTone).
 *
 * A team-match challenge (challenge.teamMatch, the same field behind ChallengeBadgeRow's
 * 👥 badges) carries a small "T" badge before the title.
 *
 * Each chip also leads with a status dot — pulsing blue for an open boost
 * window, red for low exposure (utils/challengeAlerts) — so the whole
 * situation reads off this one panel. The meaning is repeated in sr-only text.
 */
export function ChallengeNav({ challenges }: { challenges?: Challenge[] | null }) {
    const { t } = useTranslation();

    const list = challenges || [];
    const customized = useCustomizedChallengeIds(list);

    if (list.length === 0) return null;

    // No tick: the dots refresh with each challenge refetch, like StatusHeader.
    const nowSec = Math.floor(Date.now() / 1000);

    return (
        <ChipListPanel icon="📋" label={t('app.jumpToChallenge')} count={list.length}>
            {list.map((c) => (
                <NavChip key={c?.id} challenge={c} kind={customized.get(String(c?.id))} nowSec={nowSec} />
            ))}
        </ChipListPanel>
    );
}
