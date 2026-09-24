import { useTranslation } from '@/contexts/TranslationContext';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';

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
                    <button className={`btn btn-sm ${running ? 'btn-error' : 'btn-latvian'}`} onClick={onToggle}>
                        {running ? (
                            <>
                                <StrokeIcon className="w-4 h-4 mr-1" d={ICON_PATHS.close} />
                                {t('app.stopAutoVote')}
                            </>
                        ) : (
                            <>
                                <StrokeIcon className="w-4 h-4 mr-1" d={ICON_PATHS.smile} />
                                {t('app.startAutoVote')}
                            </>
                        )}
                    </button>

                    {/* Status Info */}
                    <div className="flex flex-wrap items-center gap-4">
                        {/* Status Badge */}
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{t('app.status')}</span>
                            <span className={`badge badge-sm ${statusClass}`}>{status}</span>
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
