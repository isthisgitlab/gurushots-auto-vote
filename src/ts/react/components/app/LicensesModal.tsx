import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { Modal } from '@/components/ui/Modal';
import { InlineLoader } from '@/components/ui/LoadingSpinner';
import * as ipc from '@/api/ipc';
import { errorMessage } from '../../../errorMessage';

type NoticesState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; text: string };

/**
 * The third-party license texts. The text is large, so it is read when the dialog opens, not with the page. It sits in
 * a keyboard-focusable, scrollable region with its own accessible name, so it can be read and scrolled without a mouse.
 * A read that fails says so and offers to try again.
 */
export function LicensesModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const [state, setState] = useState<NoticesState>({ status: 'loading' });
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        if (!isOpen) return undefined;
        let cancelled = false;
        setState({ status: 'loading' });
        void (async () => {
            try {
                const result = await ipc.getThirdPartyNotices();
                if (cancelled) return;
                if (result?.success) {
                    setState({ status: 'ready', text: result.text });
                    return;
                }
                void ipc.logRendererWarning(`Third-party notices unavailable: ${result?.error ?? 'no answer'}`);
            } catch (err) {
                if (cancelled) return;
                void ipc.logRendererWarning(`Third-party notices unavailable: ${errorMessage(err) || err}`);
            }
            setState({ status: 'error' });
        })();
        return () => {
            cancelled = true;
        };
    }, [isOpen, attempt]);

    const retry = useCallback(() => setAttempt((n) => n + 1), []);

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t('about.licensesTitle')} size="xl">
            {state.status === 'loading' && <InlineLoader text={t('common.loading')} />}
            {state.status === 'error' && (
                <div role="alert" className="alert alert-error py-2 text-sm">
                    <span className="flex-1">{t('about.licensesLoadError')}</span>
                    <button type="button" className="btn btn-sm max-sm:min-h-10" onClick={retry}>
                        {t('about.licensesRetry')}
                    </button>
                </div>
            )}
            {state.status === 'ready' && (
                <pre
                    role="region"
                    // A scrollable region has to be reachable by keyboard (WCAG 2.1.1), hence the tab stop on this
                    // non-interactive element.
                    // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                    tabIndex={0}
                    aria-label={t('about.licensesTextLabel')}
                    className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded bg-base-200 p-3 text-xs"
                >
                    {state.text}
                </pre>
            )}
        </Modal>
    );
}
