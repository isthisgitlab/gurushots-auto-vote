import { useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { LicensesModal } from './LicensesModal';
import { DeleteLocalDataModal } from './DeleteLocalDataModal';

/**
 * The settings modal's last section: the third-party licenses, and the danger zone with "Delete all local data".
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
