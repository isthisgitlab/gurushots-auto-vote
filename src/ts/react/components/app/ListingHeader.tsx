import { useTranslation } from '@/contexts/TranslationContext';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { dateLocale } from '@/utils/formatters';
import { interp } from '@/utils/interp';

/** When the listing was read, as the line above the photos words it: the time, with the date when it is not today. */
const readAtText = (readAtMs: number, t: (key: string) => string): string => {
    const at = new Date(readAtMs);
    const locale = dateLocale();
    const time = at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
    if (at.toDateString() === new Date().toDateString()) return interp(t('app.photoChooserAsOf'), { time });
    return interp(t('app.photoChooserAsOfDate'), { date: at.toLocaleDateString(locale), time });
};

/**
 * What the status line says while the listing is a preview, or after a re-check that failed. The submit
 * modal holds picking in both, which its lines say.
 */
const statusKey = ({
    recheckFailed,
    hasChallenge,
    submit,
}: {
    recheckFailed: boolean;
    hasChallenge: boolean;
    submit: boolean;
}): string => {
    const base = recheckFailed ? 'app.photoChooserRecheckFailed' : 'app.photoChooserPreview';
    if (submit) return `${base}Submit`;
    return hasChallenge ? base : `${base}NoChallenge`;
};

/**
 * The first thing in a ready listing, outside every status line that counts what is picked: when the photos
 * were read with the button that reads them again at once, and the line that says they are shown as last
 * loaded (a preview, or a re-check that failed).
 */
export function ListingHeader({
    readAtMs,
    reading,
    disabled,
    preview,
    recheckFailed,
    hasChallenge,
    submit,
    onRefresh,
}: {
    readAtMs: number;
    reading: boolean;
    disabled: boolean;
    preview: boolean;
    recheckFailed: boolean;
    hasChallenge: boolean;
    /** The grid is the submit modal's: picking is held while a preview shows, and its lines say so. */
    submit: boolean;
    onRefresh: () => void;
}) {
    const { t } = useTranslation();
    return (
        <>
            <div className="flex items-center justify-between gap-2">
                <p className="text-base-content/70 text-xs" role="status">
                    {readAtText(readAtMs, t)}
                </p>
                <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    aria-label={t('app.photoChooserRefreshLabel')}
                    aria-busy={reading}
                    disabled={reading || disabled}
                    onClick={onRefresh}
                >
                    {reading && <LoadingSpinner size="xs" decorative />}
                    {t('app.photoChooserRefresh')}
                </button>
            </div>
            {(preview || recheckFailed) && (
                <p className="text-base-content/70 text-xs" role="status">
                    {t(statusKey({ recheckFailed, hasChallenge, submit }))}
                </p>
            )}
        </>
    );
}
