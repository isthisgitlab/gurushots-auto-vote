import { useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSettingsNav } from '@/contexts/SettingsNavContext';
import { ToneIcon } from '@/components/ui/ToneNote';
import { useImportRefText, useImportReport } from '@/api/useImportReport';
import { usePlatformCapabilities } from '@/api/usePlatformCapabilities';
import { matchesSettingFilter } from '@/utils/matchesSettingFilter';
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
            <h6 className="font-medium mb-1">{t('about.importTitle')}</h6>
            <p className="text-xs text-base-content/70 mb-1">
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
 * The heading, button labels and descriptions of the block: the texts the settings filter searches (like
 * applicationCellTexts).
 */
export const ABOUT_DATA_TEXT_KEYS = [
    'about.title',
    'about.licensesButton',
    'about.licensesDesc',
    'about.importTitle',
    'about.dangerTitle',
    'about.deleteButton',
    'about.deleteDesc',
];

/**
 * Whether the block matches the settings filter `query`.
 */
export const aboutDataMatchesFilter = (t: (key: string) => string, query: string): boolean =>
    matchesSettingFilter(
        ABOUT_DATA_TEXT_KEYS.map((key) => t(key)),
        query,
    );

/**
 * The Application panel's last block: the third-party licenses, the report of the settings import, and the danger zone
 * with "Delete all local data".
 */
export function AboutDataSection() {
    const { t } = useTranslation();
    const { query } = useSettingsNav();
    const [licensesOpen, setLicensesOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    return (
        <div className={`mb-4 ${aboutDataMatchesFilter(t, query) ? '' : 'hidden'}`}>
            <h5 className="font-medium text-sm opacity-70 mb-2 mt-3">{t('about.title')}</h5>
            <div className="flex flex-wrap items-center gap-3 mb-4">
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setLicensesOpen(true)}>
                    {t('about.licensesButton')}
                </button>
                <span className="text-xs text-base-content/70">{t('about.licensesDesc')}</span>
            </div>
            <ImportReportBlock />
            <div className="rounded-lg border border-error/50 p-3">
                <h6 className="font-medium text-sm mb-1">
                    <ToneIcon tone="error" />
                    {t('about.dangerTitle')}
                </h6>
                <div className="flex flex-wrap items-center gap-3">
                    <button type="button" className="btn btn-error btn-sm" onClick={() => setDeleteOpen(true)}>
                        {t('about.deleteButton')}
                    </button>
                    <span className="text-xs text-base-content/70">{t('about.deleteDesc')}</span>
                </div>
            </div>
            <LicensesModal isOpen={licensesOpen} onClose={() => setLicensesOpen(false)} />
            <DeleteLocalDataModal isOpen={deleteOpen} onClose={() => setDeleteOpen(false)} />
        </div>
    );
}
