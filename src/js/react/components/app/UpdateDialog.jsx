import { useTranslation } from '@/contexts/TranslationContext';
import { useUpdate, UPDATE_STATES } from '@/contexts/UpdateContext';
import { Modal } from '@/components/ui/Modal';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';

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
 * Update dialog component with multiple states. Built on ui/Modal (focus trap,
 * Escape, backdrop); it can only be dismissed that way while an update is
 * merely available or has failed — mid-download or ready-to-install it closes
 * only through its own buttons.
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

    const dismissable = state === UPDATE_STATES.AVAILABLE || state === UPDATE_STATES.ERROR;
    const title = {
        [UPDATE_STATES.AVAILABLE]: t('app.updateAvailable'),
        [UPDATE_STATES.DOWNLOADING]: t('app.downloadingUpdate'),
        [UPDATE_STATES.READY]: t('app.updateReady'),
        [UPDATE_STATES.ERROR]: t('app.updateError'),
    }[state];

    return (
        <Modal
            isOpen={dialogVisible}
            onClose={dismissable ? hideDialog : undefined}
            title={title}
            showCloseButton={false}
        >
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
                                <span className="badge badge-warning badge-sm ml-1">Pre-release</span>
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
                    <StrokeIcon className="w-5 h-5" d={ICON_PATHS.vote} />
                    <span>{t('app.updateReadyToInstall')}</span>
                </div>
            )}

            {/* Error State — SET_ERROR always carries an error payload. */}
            {state === UPDATE_STATES.ERROR && (
                <div className="alert alert-error">
                    <StrokeIcon className="w-5 h-5" d={ICON_PATHS.xCircle} />
                    <span>{error.message}</span>
                </div>
            )}

            {/* Buttons */}
            <div className="modal-action">
                {/* Available Buttons */}
                {state === UPDATE_STATES.AVAILABLE && (
                    <>
                        <button className="btn btn-outline btn-sm" onClick={skipVersion}>
                            {t('app.skipVersion')}
                        </button>
                        <button className="btn btn-outline btn-sm" onClick={hideDialog}>
                            {t('app.remindLater')}
                        </button>
                        <button className="btn btn-latvian btn-sm" onClick={startDownload}>
                            {t('app.download')}
                        </button>
                    </>
                )}

                {/* Downloading Buttons */}
                {state === UPDATE_STATES.DOWNLOADING && (
                    <button className="btn btn-outline btn-sm" onClick={hideDialog}>
                        {t('app.cancel')}
                    </button>
                )}

                {/* Ready Buttons */}
                {state === UPDATE_STATES.READY && (
                    <>
                        <button className="btn btn-outline btn-sm" onClick={hideDialog}>
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
                        <button className="btn btn-outline btn-sm" onClick={hideDialog}>
                            {t('app.close')}
                        </button>
                        {error.canFallbackToBrowser && (
                            <button className="btn btn-latvian btn-sm" onClick={openBrowserDownload}>
                                {t('app.downloadInBrowser')}
                            </button>
                        )}
                    </>
                )}
            </div>
        </Modal>
    );
}
