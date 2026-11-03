import { useTranslation } from '@/contexts/TranslationContext';
import { usePlatformCapabilities } from '@/api/usePlatformCapabilities';

/**
 * The schema keys whose value is a view preference the remote page keeps on the device instead of the
 * computer's config.json — the rows its "Saved on this device only." hint describes. Global-default and
 * per-challenge surfaces gate their rows on this set; nothing else shows the hint.
 */
export const LOCAL_VIEW_PREF_KEYS: ReadonlySet<string> = new Set(['compactCards', 'compactCardActions']);

/**
 * "Saved on this device only." — the one-line hint telling a remote-screen user that the control next to it
 * writes the device's own view preference, not the computer's settings. Renders nothing on every other
 * platform, so callers never branch on the platform themselves: they give each instance its own `id` and
 * point the control's `aria-describedby` at it when `viewPrefsLocal` is true. `srOnly` renders the same text
 * visually hidden, for a control whose row cannot take an extra visible line (the challenges toolbar).
 */
export function LocalOnlyHint({ id, srOnly = false }: { id: string; srOnly?: boolean }) {
    const { t } = useTranslation();
    const { viewPrefsLocal } = usePlatformCapabilities();
    if (!viewPrefsLocal) return null;
    return srOnly ? (
        <span id={id} className="sr-only">
            {t('app.savedOnThisDevice')}
        </span>
    ) : (
        <p id={id} className="text-xs text-base-content/70">
            {t('app.savedOnThisDevice')}
        </p>
    );
}
