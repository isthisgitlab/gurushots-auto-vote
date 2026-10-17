import { useTranslation } from '@/contexts/TranslationContext';

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
 * not the card around it; uncoloured while time is left, red once the challenge has ended.
 *
 * @param props.source - the card's `timeRemaining`
 * @param props.className - extra classes for the span
 */
export function Countdown({ source, className = '' }: { source: TimeRemaining; className?: string }) {
    const { t } = useTranslation();
    const value = isSignal(source) ? source.value : source;
    const ended = value === null;
    const text = ended ? t('app.ended') : value || t('common.loading');
    return <span className={`${ended ? 'text-error' : ''} ${className}`.trim()}>{text}</span>;
}
