import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSettingsNav } from '@/contexts/SettingsNavContext';
import { matchesFilterTexts } from '@/utils/matchesSettingFilter';
import { callOrNull, getRemoteAccess, resetRemotePairing, setRemoteAccess } from '@/api/ipc';

import type { SettingFilterTexts } from '@/utils/matchesSettingFilter';
import type { Translate } from '../../../core/translations/translator';

/** The answer of get-remote-access, with the success wrapper taken off. */
type RemoteAccessInfo = { enabled: boolean; link: string; qrDataUrl: string };

/** Announces to the desktop host (and anything else listening) that the pairing changed. */
const announcePairingChange = (): void => {
    window.dispatchEvent(new CustomEvent('remote-access:changed'));
};

const REMOTE_ACCESS_NAME_KEYS = ['app.remoteAccess', 'app.remoteToggleLabel', 'app.remoteResetPairing'];
const REMOTE_ACCESS_DESCRIPTION_KEYS = [
    'app.remoteAccessDesc',
    'app.remoteNote1',
    'app.remoteNote2',
    'app.remoteNote3',
];

/** The searchable texts of the section, like the hand-written cells have. */
export const remoteAccessTexts = (t: Translate): SettingFilterTexts => ({
    names: REMOTE_ACCESS_NAME_KEYS.map((key) => t(key)),
    descriptions: REMOTE_ACCESS_DESCRIPTION_KEYS.map((key) => t(key)),
});

/**
 * The Application panel's "Remote access" section: the toggle, and — behind a Show button, so
 * a screenshot or screen share does not catch them — the QR code and the pairing link. The
 * pairing key lives in the link and the QR only; neither is ever logged.
 */
export function RemoteAccessSection({ showAll }: { showAll?: boolean }) {
    const { t } = useTranslation();
    const { query, namesOnly } = useSettingsNav();
    const [info, setInfo] = useState<RemoteAccessInfo | null>(null);
    const [revealed, setRevealed] = useState(false);
    const [copied, setCopied] = useState(false);
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(async (): Promise<void> => {
        const answer = await callOrNull(() => getRemoteAccess());
        if (answer?.success === true) {
            setInfo({ enabled: answer.enabled === true, link: answer.link, qrDataUrl: answer.qrDataUrl });
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const change = async (enabled: boolean): Promise<void> => {
        setBusy(true);
        try {
            await setRemoteAccess(enabled);
            await refresh();
            announcePairingChange();
        } finally {
            setBusy(false);
        }
    };

    const reset = async (): Promise<void> => {
        setBusy(true);
        try {
            await resetRemotePairing();
            setRevealed(false);
            await refresh();
            announcePairingChange();
        } finally {
            setBusy(false);
        }
    };

    const copy = async (link: string): Promise<void> => {
        try {
            await navigator.clipboard.writeText(link);
            setCopied(true);
        } catch {
            // A browser that refuses the clipboard keeps the link readable next to the button.
        }
    };

    const shown = showAll || matchesFilterTexts(remoteAccessTexts(t), query, namesOnly);

    return (
        <div className={`mb-4 ${shown ? '' : 'hidden'}`}>
            <h5 className="font-medium text-sm opacity-70 mb-2 mt-3">{t('app.remoteAccess')}</h5>
            <p className="text-xs text-base-content/70 mb-3">{t('app.remoteAccessDesc')}</p>
            <div className="flex flex-wrap items-center gap-3 mb-3">
                <label className="flex items-center gap-2 cursor-pointer" htmlFor="remote-access-toggle">
                    <input
                        id="remote-access-toggle"
                        type="checkbox"
                        className="toggle toggle-sm"
                        checked={info?.enabled ?? false}
                        disabled={busy || info === null}
                        onChange={(e) => void change(e.currentTarget.checked)}
                    />
                    <span className="text-sm">{t('app.remoteToggleLabel')}</span>
                </label>
                <span className="text-xs text-base-content/70" role="status">
                    {(info?.enabled ?? false) ? t('app.remoteStatusOn') : t('app.remoteStatusOff')}
                </span>
            </div>
            {info !== null && info.enabled && (
                <div className="mb-3">
                    {!revealed ? (
                        <button type="button" className="btn btn-outline btn-sm" onClick={() => setRevealed(true)}>
                            {t('app.remoteShow')}
                        </button>
                    ) : (
                        <div className="flex flex-wrap items-start gap-4">
                            <img
                                src={info?.qrDataUrl}
                                alt={t('app.remoteQrAlt')}
                                className="w-48 h-48 bg-base-100 rounded-lg border border-base-300"
                                width={192}
                                height={192}
                            />
                            <div className="flex flex-col gap-2 min-w-0">
                                <code className="text-xs break-all max-w-md">{info?.link}</code>
                                <div className="flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        className="btn btn-outline btn-sm"
                                        onClick={() => void copy(info.link)}
                                    >
                                        {copied ? t('app.remoteLinkCopied') : t('app.remoteCopyLink')}
                                    </button>
                                    <button
                                        type="button"
                                        className="btn btn-error btn-sm"
                                        disabled={busy}
                                        onClick={() => void reset()}
                                    >
                                        {t('app.remoteResetPairing')}
                                    </button>
                                    <button
                                        type="button"
                                        className="btn btn-ghost btn-sm"
                                        onClick={() => setRevealed(false)}
                                    >
                                        {t('app.remoteHide')}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}
            <ul className="list-disc ml-5 text-xs text-base-content/70 space-y-1">
                <li>{t('app.remoteNote1')}</li>
                <li>{t('app.remoteNote2')}</li>
                <li>{t('app.remoteNote3')}</li>
            </ul>
        </div>
    );
}
