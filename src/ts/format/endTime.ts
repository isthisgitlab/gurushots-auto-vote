/**
 * A challenge's end time as the challenge card shows it: day, month, year and 24-hour time, in the named
 * timezone ('local' for the device's; a zone that is not valid falls back to it). The renderer words it for the UI's
 * language and the CLI in English, so both write the same instant the same way.
 */

const FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
};

/**
 * @param endTime - Unix timestamp, in seconds
 * @param timezone - 'local' or an IANA zone name (e.g. 'Europe/Riga')
 * @param locale - BCP 47 locale the date is written in
 */
const formatEndTimeIn = (endTime: number, timezone: string, locale: string): string => {
    const date = new Date(endTime * 1000);
    if (timezone === 'local') return date.toLocaleString(locale, FORMAT_OPTIONS);
    try {
        return date.toLocaleString(locale, { ...FORMAT_OPTIONS, timeZone: timezone });
    } catch {
        // Fallback to local on invalid timezone
        return date.toLocaleString(locale, FORMAT_OPTIONS);
    }
};

export { formatEndTimeIn };
