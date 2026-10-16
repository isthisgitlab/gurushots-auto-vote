import { useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useImportRefText, useImportReport } from '@/api/useImportReport';
import { usePlatformCapabilities } from '@/api/usePlatformCapabilities';
import { interp } from '@/utils/interp';
import { dateLocale } from '@/utils/formatters';
import { LicensesModal } from './LicensesModal';
import { DeleteLocalDataModal } from './DeleteLocalDataModal';

/**
 * What the import of settings.json left unresolved, read-only: when it ran and the references that
 * were kept and still do not apply (or that nothing needed attention). Nothing when the settings were not imported.
 */
function ImportReportBlock() {
    const { t } = useTranslation();
    // Where there is no settings.json for the user to know of (Android), the text does not name one.
    const { settingsFile } = usePlatformCapabilities();
    // A read that fails shows nothing: the block is a record, and the settings work without it.
    const { data: report } = useImportReport();
    const refText = useImportRefText();
    if (!report) return null;
    const date = new Date(report.at);
    return (
        <div className="mb-4 text-sm">
            <h5 className="font-medium mb-1">{t('about.importTitle')}</h5>
            <p className="text-xs text-base-content/60 mb-1">
                {interp(t(settingsFile ? 'about.importAt' : 'about.importAtAndroid'), {
                    date: Number.isNaN(date.getTime()) ? report.at : date.toLocaleDateString(dateLocale()),
                })}
            </p>
            {report.refsBlocked.length === 0 ? (
                <p>{t('about.importNone')}</p>
            ) : (
                <>
                    <p>{t('about.importSome')}</p>
                    <ul className="list-disc ml-5 break-words">
                        {report.refsBlocked.map((ref, index) => (
                            // Two entries can read alike (the same name twice), so the position is part of the key.
                            <li key={`${index}:${typeof ref === 'string' ? 'text' : ref.holder.kind}`}>
                                {refText(ref)}
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </div>
    );
}

/**
 * The settings modal's last section: the third-party licenses, the report of the settings import, and the danger zone
 * with "Delete all local data".
 */
export function AboutDataSection() {
    const { t } = useTranslation();
    const [licensesOpen, setLicensesOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    return (
        <div>
            <h4 className="font-semibold text-base mb-3 border-b border-base-300 pb-2">{t('about.title')}</h4>
            <div className="flex flex-wrap items-center gap-3 mb-4">
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setLicensesOpen(true)}>
                    {t('about.licensesButton')}
                </button>
                <span className="text-xs text-base-content/60">{t('about.licensesDesc')}</span>
            </div>
            <ImportReportBlock />
            <div className="rounded-lg border border-error/50 p-3">
                <h5 className="font-medium text-sm text-error mb-1">{t('about.dangerTitle')}</h5>
                <div className="flex flex-wrap items-center gap-3">
                    <button
                        type="button"
                        className="btn btn-outline btn-error btn-sm"
                        onClick={() => setDeleteOpen(true)}
                    >
                        {t('about.deleteButton')}
                    </button>
                    <span className="text-xs text-base-content/60">{t('about.deleteDesc')}</span>
                </div>
            </div>
            <LicensesModal isOpen={licensesOpen} onClose={() => setLicensesOpen(false)} />
            <DeleteLocalDataModal isOpen={deleteOpen} onClose={() => setDeleteOpen(false)} />
        </div>
    );
}
