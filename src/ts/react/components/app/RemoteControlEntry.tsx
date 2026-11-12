import { useCallback, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSettingsNav } from '@/contexts/SettingsNavContext';
import { matchesFilterTexts } from '@/utils/matchesSettingFilter';
import { Modal, ModalActions } from '@/components/ui/Modal';
import { phoneRemoteMode } from '../../../core/remote/phoneMode';

import type { SettingFilterTexts } from '@/utils/matchesSettingFilter';
import type { Translate } from '../../../core/translations/translator';
import type { PhoneRemoteMode, RemoteModeEntry } from '../../../core/remote/phoneMode';

const REMOTE_CONTROL_NAME_KEYS = ['app.remoteControlEntry', 'app.remoteControlConnect'];
const REMOTE_CONTROL_DESCRIPTION_KEYS = [
    'app.remoteControlEntryDesc',
    'app.remoteControlHint',
    'app.remoteControlLinkLabel',
];

/** The searchable texts of the entry, like the section blocks have. */
export const remoteControlTexts = (t: Translate): SettingFilterTexts => ({
    names: REMOTE_CONTROL_NAME_KEYS.map((key) => t(key)),
    descriptions: REMOTE_CONTROL_DESCRIPTION_KEYS.map((key) => t(key)),
});

/** The failure an enter answer carries: link-version mismatch says which app needs updating. */
const failureMessageKey = (answer: RemoteModeEntry): string => {
    if (answer.error === 'bad-link') return 'errors.remoteBadLink';
    if (answer.error === 'update-computer') return 'errors.remoteLinkOlder';
    if (answer.error === 'update-phone') return 'errors.remoteLinkNewer';
    return 'errors.remoteEnterFailed';
};

function RemoteControlDialog({ enter, showAll }: { enter: NonNullable<PhoneRemoteMode['enter']>; showAll?: boolean }) {
    const { t } = useTranslation();
    const { query, namesOnly } = useSettingsNav();
    const [open, setOpen] = useState(false);
    const [link, setLink] = useState('');
    const [failure, setFailure] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const shown = showAll || matchesFilterTexts(remoteControlTexts(t), query, namesOnly);

    const connect = useCallback(async () => {
        setBusy(true);
        try {
            const answer = await enter(link);
            if (answer.success) {
                setOpen(false);
                return;
            }
            setFailure(failureMessageKey(answer));
        } finally {
            setBusy(false);
        }
    }, [enter, link]);

    return (
        <div className={`mb-4 ${shown ? '' : 'hidden'}`}>
            <div className="flex flex-wrap items-center gap-3">
                <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => {
                        setFailure(null);
                        setOpen(true);
                    }}
                >
                    {t('app.remoteControlEntry')}
                </button>
                <span className="text-xs text-base-content/70">{t('app.remoteControlEntryDesc')}</span>
            </div>
            <Modal isOpen={open} onClose={() => setOpen(false)} title={t('app.remoteControlTitle')} size="sm">
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        void connect();
                    }}
                >
                    <label className="block text-sm mb-1" htmlFor="remote-control-link">
                        {t('app.remoteControlLinkLabel')}
                    </label>
                    <input
                        id="remote-control-link"
                        type="text"
                        className="input input-bordered w-full"
                        value={link}
                        placeholder={t('app.remoteControlHint')}
                        onChange={(e) => {
                            setLink(e.currentTarget.value);
                            if (failure !== null) setFailure(null);
                        }}
                    />
                    {failure !== null && (
                        <div className="alert alert-error text-sm mt-3" role="alert">
                            <span>{t(failure)}</span>
                        </div>
                    )}
                    <ModalActions className="mt-4">
                        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
                            {t('app.cancel')}
                        </button>
                        <button type="submit" className="btn btn-primary" disabled={busy || link.trim() === ''}>
                            {t('app.remoteControlConnect')}
                        </button>
                    </ModalActions>
                </form>
            </Modal>
        </div>
    );
}

/**
 * The Android app's "Control my computer" entry: a small button that opens a paste dialog for
 * the pairing link. The Capacitor app entry installs it, so it renders only on the phone's
 * normal mode — the desktop, the web shell and the remote mode itself show nothing. Connecting
 * hands the WebView to the bundled remote page, so this tree never re-renders after a success.
 */
export function RemoteControlEntry({ showAll }: { showAll?: boolean }) {
    const enter = phoneRemoteMode()?.enter;
    return enter === undefined ? null : <RemoteControlDialog enter={enter} showAll={showAll} />;
}
