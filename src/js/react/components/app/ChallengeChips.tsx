import type { ComponentChildren } from 'preact';
import type { Challenge } from '../../../types/gurushots';
import type { PulseDotVariant } from '../ui/PulseDot';
import { scrollToChallenge } from '@/utils/scrollToChallenge';
import { PulseDot } from '../ui/PulseDot';

/**
 * Bordered panel above the challenge list holding a heading (emoji +
 * label + count) and a wrapping row of chips. Shared by ChallengeNav
 * and BoostWindowBanner.
 */
export function ChipListPanel({
    icon,
    label,
    count,
    children,
}: {
    icon: string;
    label: string;
    count: number;
    children: ComponentChildren;
}) {
    return (
        <div className="rounded-lg border border-base-300 bg-base-100 p-2 mb-4">
            <div className="text-sm font-medium mb-2">
                <span aria-hidden="true">{icon}</span> {label} ({count})
            </div>
            <div className="flex flex-wrap gap-2">{children}</div>
        </div>
    );
}

/**
 * One anchor chip: a small button that smooth-scrolls to the matching
 * ChallengeCard (id="challenge-<id>"). Content is caller-supplied so a
 * chip can carry extra detail (e.g. the boost countdown); `className`
 * appends DaisyUI button modifiers so a caller can set a chip apart
 * (e.g. the per-challenge-override marker in ChallengeNav). The chip keeps
 * the stock btn-sm height like every other button; a title too long for
 * the row is truncated by ChipTitle rather than wrapping the chip taller.
 */
export function ChallengeChip({
    challengeId,
    className = '',
    children,
}: {
    challengeId: Challenge['id'];
    className?: string;
    children: ComponentChildren;
}) {
    return (
        <button
            type="button"
            className={`btn btn-sm max-w-full whitespace-nowrap${className ? ` ${className}` : ''}`}
            onClick={() => scrollToChallenge(challengeId)}
        >
            {children}
        </button>
    );
}

/**
 * Challenge title inside a ChallengeChip: shrinks and ellipsizes when the
 * chip hits the row width, with the full title on hover. `hint` is appended
 * to that tooltip — the text covers most of the chip, so a chip-level hint
 * must live here to stay visible.
 */
export function ChipTitle({ hint, children }: { hint?: string; children: ComponentChildren }) {
    return (
        <span className="truncate" title={[children, hint].filter(Boolean).join(' — ') || undefined}>
            {children}
        </span>
    );
}

const alwaysPulse = () => true;

/**
 * Alert summary above the challenge list: a ChipListPanel with one chip per
 * flagged challenge (status dot + title + caller-supplied detail), each
 * scrolling to its card. Renders nothing when `items` is empty. Shared by
 * BoostWindowBanner and LowExposureBanner; the colour classes are passed whole
 * (never assembled) so Tailwind's scanner sees them.
 *
 * @param props.label - already-translated heading
 * @param props.chipClassName - DaisyUI button colour class for every chip
 * @param props.dotVariant - PulseDot colour variant
 * @param props.pulse - whether an item's dot pings
 * @param props.detail - trailing chip text
 */
export function ChallengeAlertPanel<Item extends { id: Challenge['id']; title: string }>({
    icon,
    label,
    items,
    chipClassName,
    dotVariant,
    pulse = alwaysPulse,
    detail,
}: {
    icon: string;
    label: string;
    items: Item[];
    chipClassName: string;
    dotVariant: PulseDotVariant;
    pulse?: (item: Item) => boolean;
    detail: (item: Item) => ComponentChildren;
}) {
    if (items.length === 0) return null;

    return (
        <ChipListPanel icon={icon} label={label} count={items.length}>
            {items.map((c) => (
                <ChallengeChip key={c.id} challengeId={c.id} className={chipClassName}>
                    <PulseDot variant={dotVariant} pulse={pulse(c)} size="status-sm" />
                    <ChipTitle>{c.title}</ChipTitle>
                    {detail(c)}
                </ChallengeChip>
            ))}
        </ChipListPanel>
    );
}
