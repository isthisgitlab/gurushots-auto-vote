import { useTranslation } from '@/contexts/TranslationContext';
import { openDonatePage } from '@/api/donate';
import { usePlatformCapabilities } from '@/api/usePlatformCapabilities';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';

/**
 * Main app navbar with title, mock status, donate, logs (Android), settings, and logout
 */
export function Navbar({
    isMock,
    onLogsClick,
    onSettingsClick,
    onLogout,
}: {
    isMock: boolean;
    onLogsClick: () => void;
    onSettingsClick: () => void;
    onLogout: () => void | Promise<void>;
}) {
    const { t } = useTranslation();
    // The in-app Logs button is only for platforms without a menu to open the Logs window from (Android).
    const { inAppLogs: showLogs } = usePlatformCapabilities();

    return (
        <div className="navbar bg-base-100 shadow-md mb-4">
            <div className="navbar-start w-auto flex-1 min-w-0 flex-wrap gap-x-2">
                <h1 className="text-xl font-bold">{t('app.title')}</h1>
                {isMock && <span className="badge badge-warning badge-sm whitespace-nowrap">{t('app.mockMode')}</span>}
            </div>
            <div className="navbar-end w-auto shrink-0 gap-2">
                <button
                    type="button"
                    className="btn btn-primary btn-sm max-sm:min-h-10"
                    onClick={openDonatePage}
                    title={t('about.donateDesc')}
                    aria-label={t('app.donate')}
                >
                    <StrokeIcon className="w-4 h-4" d={ICON_PATHS.heart} />
                    <span className="hidden sm:inline">{t('app.donate')}</span>
                </button>
                {showLogs && (
                    <button
                        className="btn btn-outline btn-sm max-sm:min-h-10"
                        onClick={onLogsClick}
                        title={t('logs.title')}
                        aria-label={t('logs.title')}
                    >
                        <StrokeIcon className="w-4 h-4" d={ICON_PATHS.document} />
                    </button>
                )}
                <button
                    className="btn btn-outline btn-sm max-sm:min-h-10"
                    onClick={onSettingsClick}
                    title={t('app.settings')}
                    aria-label={t('app.settings')}
                >
                    <StrokeIcon className="w-4 h-4" d={ICON_PATHS.cog} />
                </button>
                <button
                    className="btn btn-outline btn-sm max-sm:min-h-10"
                    onClick={() => void onLogout()}
                    title={t('app.logout')}
                    aria-label={t('app.logout')}
                >
                    <StrokeIcon className="w-4 h-4" d={ICON_PATHS.logout} />
                </button>
            </div>
        </div>
    );
}
