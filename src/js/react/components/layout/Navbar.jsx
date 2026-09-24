import { useTranslation } from '@/contexts/TranslationContext';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';

// Detect a real native (Android) platform without importing the node-flavored
// runtime into the browser bundle. The in-app Logs button is only shown on
// Capacitor — Electron opens the Logs window from the application menu instead.
const isCapacitorPlatform = () => globalThis.Capacitor?.isNativePlatform?.() === true;

/**
 * Main app navbar with title, mock status, logs (Android), settings, and logout
 */
export function Navbar({ isMock, onLogsClick, onSettingsClick, onLogout }) {
    const { t } = useTranslation();
    const showLogs = isCapacitorPlatform();

    return (
        <div className="navbar bg-base-100 shadow-md mb-4">
            <div className="navbar-start">
                <h1 className="text-xl font-bold">{t('app.title')}</h1>
                {isMock && <span className="badge badge-warning ml-2 whitespace-nowrap">{t('app.mockMode')}</span>}
            </div>
            <div className="navbar-end gap-2">
                {showLogs && (
                    <button
                        className="btn btn-ghost btn-sm"
                        onClick={onLogsClick}
                        title={t('logs.title')}
                        aria-label={t('logs.title')}
                    >
                        <StrokeIcon className="w-5 h-5" d={ICON_PATHS.document} />
                    </button>
                )}
                <button
                    className="btn btn-ghost btn-sm"
                    onClick={onSettingsClick}
                    title={t('app.settings')}
                    aria-label={t('app.settings')}
                >
                    <StrokeIcon className="w-5 h-5" d={ICON_PATHS.cog} />
                </button>
                <button
                    className="btn btn-ghost btn-sm text-error"
                    onClick={onLogout}
                    title={t('app.logout')}
                    aria-label={t('app.logout')}
                >
                    <StrokeIcon className="w-5 h-5" d={ICON_PATHS.logout} />
                </button>
            </div>
        </div>
    );
}
