import { scrollToChallenge } from '@/utils/scrollToChallenge';
import { PulseDot } from '../ui/PulseDot';

/**
 * Bordered panel above the challenge list holding a heading (emoji +
 * label + count) and a wrapping row of chips. Shared by ChallengeNav
 * and BoostWindowBanner.
 */
export function ChipListPanel({ icon, label, count, children }) {
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
export function ChallengeChip({ challengeId, className = '', children }) {
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
export function ChipTitle({ hint, children }) {
    return (
        <span className="truncate" title={hint ? `${children} — ${hint}` : children}>
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
 * @param {object} props
 * @param {string} props.icon
 * @param {string} props.label - already-translated heading
 * @param {Array<{id: string|number, title: string}>} props.items
 * @param {string} props.chipClassName - DaisyUI button colour class for every chip
 * @param {string} props.dotVariant - PulseDot colour variant
 * @param {(item: object) => boolean} [props.pulse] - whether an item's dot pings
 * @param {(item: object) => import('react').ReactNode} props.detail - trailing chip text
 */
export function ChallengeAlertPanel({ icon, label, items, chipClassName, dotVariant, pulse = alwaysPulse, detail }) {
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
