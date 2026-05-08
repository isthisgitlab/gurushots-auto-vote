import { useTranslation } from '@/contexts/TranslationContext';

/**
 * Autovote controls - toggle button, status, last run, cycle count
 */
export function AutoVoteControls({ running, status, statusClass, lastRun, cycles, onToggle }) {
    const { t } = useTranslation();

    return (
        <div className="card bg-base-100 shadow-md mb-4">
            <div className="card-body p-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                    {/* Toggle Button */}
                    <button className={`btn ${running ? 'btn-error' : 'btn-latvian'}`} onClick={onToggle}>
                        {running ? (
                            <>
                                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth="2"
                                        d="M6 18L18 6M6 6l12 12"
                                    />
                                </svg>
                                {t('app.stopAutoVote')}
                            </>
                        ) : (
                            <>
                                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth="2"
                                        d="M14.828 14.828a4 4 0 01-5.656 0M9 10h1m4 0h1m-6 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                    />
                                </svg>
                                {t('app.startAutoVote')}
                            </>
                        )}
                    </button>

                    {/* Status Info */}
                    <div className="flex flex-wrap items-center gap-4">
                        {/* Status Badge */}
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{t('app.status')}</span>
                            <span className={`badge ${statusClass}`}>{status}</span>
                        </div>

                        {/* Last Run */}
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{t('app.lastRun')}</span>
                            <span className="text-sm">{lastRun || '-'}</span>
                        </div>

                        {/* Cycle Count */}
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{t('app.cycles')}</span>
                            <span className="text-sm">{cycles}</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
