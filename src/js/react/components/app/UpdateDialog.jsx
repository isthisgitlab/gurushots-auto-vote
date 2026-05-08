import { useTranslation } from '@/contexts/TranslationContext';
import { useUpdate, UPDATE_STATES } from '@/contexts/UpdateContext';

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes, decimals = 1) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

/**
 * Update dialog component with multiple states
 */
export function UpdateDialog() {
    const { t } = useTranslation();
    const {
        state,
        updateInfo,
        progress,
        error,
        dialogVisible,
        startDownload,
        installUpdate,
        skipVersion,
        hideDialog,
        openBrowserDownload,
    } = useUpdate();

    if (!dialogVisible) return null;

    const handleBackdropClick = (e) => {
        if (e.target === e.currentTarget) {
            // Only close in available or error states
            if (state === UPDATE_STATES.AVAILABLE || state === UPDATE_STATES.ERROR) {
                hideDialog();
            }
        }
    };

    return (
        <div
            className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
            onClick={handleBackdropClick}
        >
            <div className="modal-box max-w-md">
                {/* Title */}
                <h3 className="font-bold text-lg mb-4">
                    {state === UPDATE_STATES.AVAILABLE && t('app.updateAvailable')}
                    {state === UPDATE_STATES.DOWNLOADING && t('app.downloadingUpdate')}
                    {state === UPDATE_STATES.READY && t('app.updateReady')}
                    {state === UPDATE_STATES.ERROR && t('app.updateError')}
                </h3>

                {/* Available State */}
                {state === UPDATE_STATES.AVAILABLE && updateInfo && (
                    <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4 text-sm">
                            <div>
                                <span className="text-base-content/60">{t('app.currentVersion')}:</span>
                                <span className="ml-2 font-mono">{updateInfo.currentVersion}</span>
                            </div>
                            <div>
                                <span className="text-base-content/60">{t('app.latestVersion')}:</span>
                                <span className="ml-2 font-mono">{updateInfo.latestVersion}</span>
                                {updateInfo.isPrerelease && (
                                    <span className="badge badge-warning badge-xs ml-1">Pre-release</span>
                                )}
                            </div>
                        </div>
                        {updateInfo.releaseNotes && (
                            <div>
                                <h4 className="font-medium text-sm mb-1">{t('app.releaseNotes')}:</h4>
                                <div className="bg-base-200 rounded p-2 text-sm max-h-40 overflow-y-auto">
                                    {updateInfo.releaseNotes}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* Downloading State */}
                {state === UPDATE_STATES.DOWNLOADING && progress && (
                    <div className="space-y-4">
                        <progress className="progress progress-latvian w-full" value={progress.percent} max="100" />
                        <div className="flex justify-between text-sm">
                            <span>{progress.percent}%</span>
                            {progress.bytesPerSecond > 0 && (
                                <span>
                                    {formatBytes(progress.transferred)} / {formatBytes(progress.total)} (
                                    {formatBytes(progress.bytesPerSecond)}/s)
                                </span>
                            )}
                        </div>
                    </div>
                )}

                {/* Ready State */}
                {state === UPDATE_STATES.READY && (
                    <div className="alert alert-success">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                            />
                        </svg>
                        <span>{t('app.updateReadyToInstall')}</span>
                    </div>
                )}

                {/* Error State */}
                {state === UPDATE_STATES.ERROR && error && (
                    <div className="alert alert-error">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                                d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
                            />
                        </svg>
                        <span>{error.message}</span>
                    </div>
                )}

                {/* Buttons */}
                <div className="modal-action">
                    {/* Available Buttons */}
                    {state === UPDATE_STATES.AVAILABLE && (
                        <>
                            <button className="btn btn-ghost btn-sm" onClick={skipVersion}>
                                {t('app.skipVersion')}
                            </button>
                            <button className="btn btn-ghost btn-sm" onClick={hideDialog}>
                                {t('app.remindLater')}
                            </button>
                            <button className="btn btn-latvian btn-sm" onClick={startDownload}>
                                {t('app.download')}
                            </button>
                        </>
                    )}

                    {/* Downloading Buttons */}
                    {state === UPDATE_STATES.DOWNLOADING && (
                        <button className="btn btn-ghost btn-sm" onClick={hideDialog}>
                            {t('app.cancel')}
                        </button>
                    )}

                    {/* Ready Buttons */}
                    {state === UPDATE_STATES.READY && (
                        <>
                            <button className="btn btn-ghost btn-sm" onClick={hideDialog}>
                                {t('app.restartLater')}
                            </button>
                            <button className="btn btn-latvian btn-sm" onClick={installUpdate}>
                                {t('app.restartNow')}
                            </button>
                        </>
                    )}

                    {/* Error Buttons */}
                    {state === UPDATE_STATES.ERROR && (
                        <>
                            <button className="btn btn-ghost btn-sm" onClick={hideDialog}>
                                {t('app.close')}
                            </button>
                            {error?.canFallbackToBrowser && (
                                <button className="btn btn-latvian btn-sm" onClick={openBrowserDownload}>
                                    {t('app.downloadInBrowser')}
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
