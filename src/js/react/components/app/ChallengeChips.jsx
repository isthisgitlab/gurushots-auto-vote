import { scrollToChallenge } from '@/utils/scrollToChallenge';
import { PulseDot } from '../ui/PulseDot';

/**
 * Bordered panel above the challenge list holding a heading (emoji +
 * label + count) and a wrapping row of chips. Shared by ChallengeNav
 * and BoostWindowBanner, whose wrappers were structurally identical.
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
 * (e.g. the per-challenge-override marker in ChallengeNav).
 */
export function ChallengeChip({ challengeId, className = '', title, children }) {
    return (
        <button
            type="button"
            title={title}
            className={`btn btn-xs h-auto whitespace-normal text-left${className ? ` ${className}` : ''}`}
            onClick={() => scrollToChallenge(challengeId)}
        >
            {children}
        </button>
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
                    <span>{c.title}</span>
                    {detail(c)}
                </ChallengeChip>
            ))}
        </ChipListPanel>
    );
}
