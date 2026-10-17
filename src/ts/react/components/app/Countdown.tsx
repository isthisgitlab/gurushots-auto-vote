import { useTranslation } from '@/contexts/TranslationContext';
import { timeLeftTone, toneBadgeClass } from '@/utils/statTone';

import type { Signal } from '@preact/signals';

/**
 * What a card is told about the time left: the live signal from useTimers, a plain value (a smoke test's or a
 * caller that has no timers), or nothing yet. A null value is a challenge that has ended.
 */
export type TimeRemaining = Signal<string | null> | string | null | undefined;

const isSignal = (source: TimeRemaining): source is Signal<string | null> =>
    typeof source === 'object' && source !== null;

/**
 * The countdown text. This leaf alone reads the signal's value, so the once-a-second update re-renders this span and
 * not the card around it. Without `closeTime` it is uncoloured while time is left and red text once the challenge has
 * ended. With `closeTime` it is a tone badge: green, yellow under six hours, red under an hour and when ended. The tone
 * is computed at render, and the leaf re-renders whenever the signal's string changes: every second under an hour, every
 * minute above it, with the string changing at exactly the whole-minute tone boundaries, so the colour flips on time
 * without re-rendering the card. A plain-string source never re-renders, so its colour stays as first rendered. The
 * loading text is uncoloured.
 *
 * @param props.source - the card's `timeRemaining`
 * @param props.className - extra classes for the span
 * @param props.closeTime - the challenge's close time (Unix seconds); turns on the tone badge
 * @param props.size - badge size when `closeTime` is set
 */
export function Countdown({
    source,
    className = '',
    closeTime,
    size = 'sm',
}: {
    source: TimeRemaining;
    className?: string;
    closeTime?: number;
    size?: 'sm' | 'xs';
}) {
    const { t } = useTranslation();
    const value = isSignal(source) ? source.value : source;
    const ended = value === null;
    const text = ended ? t('app.ended') : value || t('common.loading');
    let tone = '';
    if (ended) tone = closeTime === undefined ? 'text-error' : toneBadgeClass('error', size);
    else if (value && closeTime !== undefined) {
        tone = toneBadgeClass(timeLeftTone(closeTime, Math.floor(Date.now() / 1000)), size);
    }
    return <span className={`${tone} ${className}`.trim()}>{text}</span>;
}
