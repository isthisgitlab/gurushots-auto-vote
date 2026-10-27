import type { EntryEnteredTime } from '../../../types/gurushots';
import { useTranslation } from '@/contexts/TranslationContext';
import { formatEndTime } from '@/utils/formatters';

/**
 * When an entry went into its challenge, as the app recorded it. An exact time (the app submitted the photo) reads
 * "Submitted <time>". Any other is the time a fetch first showed the entry, so it went in at or before it: it reads
 * "Submitted <time> or earlier", in italics and dimmed, and says why in full to a screen reader and in a title (the
 * same pattern as the compact card's pin note: a title alone is invisible on touch and to a keyboard). An entry whose
 * time the app does not know shows nothing.
 *
 * @param props.time - the entry's `appEntered`
 * @param props.timezone - the timezone setting the card's other times use
 */
export function EntryTime({ time, timezone }: { time: EntryEnteredTime | undefined; timezone: string }) {
    const { t } = useTranslation();
    if (!time || !(time.at > 0)) return null;
    const when = formatEndTime(time.at, timezone);
    if (time.exact) return <span className="text-xs">{t('app.entrySubmitted', { time: when })}</span>;
    const long = t('app.entrySubmittedOrEarlierLong');
    return (
        <span className="text-xs italic text-base-content/70" title={long}>
            <span aria-hidden="true">{t('app.entrySubmittedOrEarlier', { time: when })}</span>
            <span className="sr-only">{`${t('app.entrySubmittedOrEarlier', { time: when })}. ${long}`}</span>
        </span>
    );
}
