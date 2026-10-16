import { useEffect, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useImportRefText, useImportReport } from '@/api/useImportReport';
import { Modal, ModalActions } from '@/components/ui/Modal';
import { BusyContent } from '@/components/ui/LoadingSpinner';
import * as ipc from '@/api/ipc';
import { errorMessage } from '../../../errorMessage';

// Whether the report is recorded as seen; a refusal or a throw is logged.
const acknowledgeReport = async (): Promise<boolean> => {
    try {
        const result: { success: boolean; error?: string } | undefined = await ipc.acknowledgeImportReport();
        if (result?.success) return true;
        void ipc.logRendererWarning(`Acknowledging the import report failed: ${result?.error ?? 'no answer'}`);
    } catch (error) {
        void ipc.logRendererError(`Acknowledging the import report threw: ${errorMessage(error) || error}`);
    }
    return false;
};

/**
 * Tells the user, once, which references of the settings imported from settings.json were kept and still do not
 * apply (a profile or scenario that is missing or no longer valid), each as the place it is stored in the app and what
 * is wrong with it, and what to do. OK
 * acknowledges it; the report stays readable under About and data. An import with nothing to report is acknowledged
 * without showing anything. An acknowledgement that cannot be saved says so and leaves the dialog open. `hold` keeps it
 * back while another notice is up (it shows when that one is gone).
 */
export function ImportReportModal({ hold = false }: { hold?: boolean }) {
    const { t } = useTranslation();
    const { data: report, refetch } = useImportReport();
    const refText = useImportRefText();
    const [saving, setSaving] = useState(false);
    const [failed, setFailed] = useState(false);

    const acknowledge = async () => {
        setSaving(true);
        const ok = await acknowledgeReport();
        setSaving(false);
        setFailed(!ok);
        if (ok) await refetch();
    };

    const pending = report !== null && !report.acknowledged;
    const empty = pending && report.refsBlocked.length === 0;
    // Nothing to show: acknowledge it, without a dialog. A refusal is logged and tried again at the next start.
    useEffect(() => {
        if (empty) void acknowledgeReport().then((ok) => (ok ? refetch() : undefined));
    }, [empty, refetch]);

    return (
        <Modal
            isOpen={pending && !empty && !hold}
            onClose={saving ? undefined : () => void acknowledge()}
            title={t('notice.importReportTitle')}
            size="md"
            showCloseButton={false}
        >
            <div className="space-y-3 text-sm">
                <p>{t('notice.importReportIntro')}</p>
                <ul className="list-disc ml-5 break-words">
                    {report?.refsBlocked.map((ref, index) => (
                        // Two entries can read alike (the same name twice), so the position is part of the key.
                        <li key={`${index}:${typeof ref === 'string' ? 'text' : ref.holder.kind}`}>{refText(ref)}</li>
                    ))}
                </ul>
                {failed && (
                    <div role="alert" className="alert alert-error py-2 text-sm">
                        <span>{t('notice.importReportFailed')}</span>
                    </div>
                )}
            </div>
            <ModalActions>
                <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void acknowledge()}
                    disabled={saving}
                    aria-busy={saving}
                >
                    <BusyContent busy={saving} label={t('common.ok')} />
                </button>
            </ModalActions>
        </Modal>
    );
}
