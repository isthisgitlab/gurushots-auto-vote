import { useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSettingsNav } from '@/contexts/SettingsNavContext';
import { ToneIcon } from '@/components/ui/ToneNote';
import { openDonatePage } from '@/api/donate';
import { useImportRefText } from '@/api/useImportReport';
import { usePlatformCapabilities } from '@/api/usePlatformCapabilities';
import { matchesFilterTexts } from '@/utils/matchesSettingFilter';
import { interp } from '@/utils/interp';
import { dateLocale } from '@/utils/formatters';
import { LicensesModal } from './LicensesModal';
import { DeleteLocalDataModal } from './DeleteLocalDataModal';

import type { ImportReport } from '@/api/useImportReport';
import type { SettingFilterTexts } from '@/utils/matchesSettingFilter';

/**
 * What the import of settings.json left unresolved, read-only: when it ran and the references that
 * were kept and still do not apply (or that nothing needed attention). Nothing when the settings were not imported.
 */
function ImportReportBlock({ report }: { report: ImportReport | null }) {
    const { t } = useTranslation();
    // Where there is no settings.json for the user to know of (Android), the text does not name one.
    const { settingsFile } = usePlatformCapabilities();
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

const ABOUT_DATA_NAME_KEYS = [
    'about.title',
    'about.donateButton',
    'about.licensesButton',
    'about.dangerTitle',
    'about.deleteButton',
];
const ABOUT_DATA_DESCRIPTION_KEYS = ['about.donateDesc', 'about.licensesDesc', 'about.deleteDesc'];

/**
 * The texts of the block the settings filter searches, like the section's cells. `hasReport` adds
 * the import heading to the names — that heading renders only while a report is shown.
 */
export const aboutDataTexts = (t: (key: string) => string, hasReport: boolean): SettingFilterTexts => ({
    names: [...ABOUT_DATA_NAME_KEYS.map((key) => t(key)), ...(hasReport ? [t('about.importTitle')] : [])],
    descriptions: ABOUT_DATA_DESCRIPTION_KEYS.map((key) => t(key)),
});

/**
 * Whether the block matches the settings filter `query`.
 */
export const aboutDataMatchesFilter = (
    t: (key: string) => string,
    query: string,
    namesOnly: boolean,
    hasReport: boolean,
): boolean => matchesFilterTexts(aboutDataTexts(t, hasReport), query, namesOnly);

/**
 * The Application panel's last block: the donation row, the third-party licenses, the report of the settings import,
 * and the danger zone with "Delete all local data".
 */
export function AboutDataSection({ report, showAll }: { report: ImportReport | null; showAll?: boolean }) {
    const { t } = useTranslation();
    const { query, namesOnly } = useSettingsNav();
    const [licensesOpen, setLicensesOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const shown = showAll || aboutDataMatchesFilter(t, query, namesOnly, report !== null);
    return (
        <div className={`mb-4 ${shown ? '' : 'hidden'}`}>
            <h5 className="font-medium text-sm opacity-70 mb-2 mt-3">{t('about.title')}</h5>
            <div className="flex flex-wrap items-center gap-3 mb-4">
                <button type="button" className="btn btn-outline btn-sm" onClick={openDonatePage}>
                    {t('about.donateButton')}
                </button>
                <span className="text-xs text-base-content/70">{t('about.donateDesc')}</span>
            </div>
            <div className="flex flex-wrap items-center gap-3 mb-4">
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setLicensesOpen(true)}>
                    {t('about.licensesButton')}
                </button>
                <span className="text-xs text-base-content/70">{t('about.licensesDesc')}</span>
            </div>
            <ImportReportBlock report={report} />
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
