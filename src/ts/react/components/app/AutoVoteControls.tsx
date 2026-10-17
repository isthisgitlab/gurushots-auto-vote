import { useEffect, useId, useRef } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { ipcErrorText } from '@/api/ipcErrorText';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';
import { formatDuration } from '@/utils/formatters';
import { interp } from '@/utils/interp';
import { useTick } from '@/hooks/useTick';

/**
 * Isolated 1Hz countdown of the startup hold on an auto-resume, so the tick
 * re-renders only this node. A late timer clamps at zero.
 */
function ResumeCountdown({ startAt }: { startAt: number }) {
    const { t } = useTranslation();
    const now = useTick(1000);
    const remaining = Math.max(0, Math.ceil(startAt / 1000) - now);
    return <span>{interp(t('app.resumeHold'), { time: formatDuration(remaining, { includeSeconds: true }) })}</span>;
}

/**
 * The held-resume notice: the countdown and a static sentence, with Start now /
 * Don't resume. No role="alert"/aria-live: the countdown ticks every second,
 * and a live region would be re-announced on each tick; the static sentence
 * describes both buttons instead. `focusInside` records whether focus is in the
 * notice (removing a focused node fires no blur), so the parent can move focus
 * on when the notice goes away.
 */
function ResumeHold({
    startAt,
    onStartNow,
    onCancelResume,
    focusInside,
}: {
    startAt: number;
    onStartNow: () => void | Promise<void>;
    onCancelResume: () => void | Promise<void>;
    focusInside: { current: boolean };
}) {
    const { t } = useTranslation();
    const noteId = useId();
    return (
        <div
            className="alert alert-info mt-3 grid-flow-row grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto]"
            onFocus={() => {
                focusInside.current = true;
            }}
            onBlur={() => {
                focusInside.current = false;
            }}
        >
            <div>
                <ResumeCountdown startAt={startAt} /> <span id={noteId}>{t('app.resumeHoldNote')}</span>
            </div>
            <div className="flex flex-wrap gap-2">
                <button className="btn btn-sm btn-neutral" aria-describedby={noteId} onClick={() => void onStartNow()}>
                    {t('app.resumeStartNow')}
                </button>
                <button className="btn btn-sm" aria-describedby={noteId} onClick={() => void onCancelResume()}>
                    {t('app.resumeCancel')}
                </button>
            </div>
        </div>
    );
}

// The reducer's machine status → the translation key of its label.
const STATUS_LABEL_KEYS: Record<string, string> = {
    Stopped: 'common.stopped',
    Running: 'common.running',
    Error: 'app.statusError',
};

/**
 * Autovote controls - toggle button, status, last run, cycle count. While an
 * auto-resume is held at launch (`pendingStartAt`) the toggle gives way to a
 * countdown with Start now / Don't resume, so there is never a second Start.
 */
export function AutoVoteControls({
    running,
    status,
    statusClass,
    error = null,
    lastRun,
    cycles,
    onToggle,
    autoJoinActive,
    pendingStartAt,
    onStartNow,
    onCancelResume,
}: {
    running: boolean;
    status: string;
    statusClass: string;
    /** why the last cycle failed (the reducer's error); shown while the status is Error */
    error?: string | null;
    lastRun: string | null;
    cycles: number;
    onToggle: () => void | Promise<void>;
    autoJoinActive: boolean;
    pendingStartAt: number | null;
    onStartNow: () => void | Promise<void>;
    onCancelResume: () => void | Promise<void>;
}) {
    const { t } = useTranslation();
    const pending = pendingStartAt !== null;
    const toggleRef = useRef<HTMLButtonElement>(null);
    const focusInHold = useRef(false);
    // The notice just went away (Start now, Don't resume, or the timer): if focus
    // was in it, it would drop to the page, so hand it to the toggle (WCAG 2.4.3).
    useEffect(() => {
        if (pending || !focusInHold.current) return;
        focusInHold.current = false;
        toggleRef.current?.focus();
    }, [pending]);

    return (
        <div className="card bg-base-100 shadow-md mb-4">
            <div className="card-body p-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                    {/* Toggle Button — hidden while a held resume offers Start now */}
                    {!pending && (
                        <button
                            ref={toggleRef}
                            className={`btn btn-sm ${running ? 'btn-error' : 'btn-neutral'}`}
                            onClick={() => void onToggle()}
                        >
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
                    )}

                    {/* Status Info */}
                    <div className="flex flex-wrap items-center gap-4">
                        {/* Status Badge */}
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{t('app.status')}</span>
                            <span className={`badge badge-sm ${pending ? 'badge-warning' : statusClass}`}>
                                {pending ? t('app.statusWaiting') : t(STATUS_LABEL_KEYS[status] ?? 'app.statusError')}
                            </span>
                            {/* Auto-join is a property of the running autovote, so it
                                sits next to the running status. Shown only while
                                autovote runs — that is when the join pre-step
                                actually executes, and showing it while autovote is
                                off would wrongly imply background joining. Own
                                polite live region so arming/disarming mid-session
                                is announced. */}
                            {autoJoinActive && running && (
                                <span
                                    className="badge badge-success badge-sm gap-1"
                                    role="status"
                                    aria-live="polite"
                                    title={t('app.autoJoinBadgeTitle')}
                                >
                                    <span aria-hidden="true">🤝</span>
                                    {t('app.autoJoinBadge')}
                                </span>
                            )}
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

                {!pending && status === 'Error' && error && (
                    <p role="alert" className="text-error text-sm mt-2">
                        {ipcErrorText(error, t, 'errors.votingFailed')}
                    </p>
                )}

                {pending && (
                    <ResumeHold
                        startAt={pendingStartAt}
                        onStartNow={onStartNow}
                        onCancelResume={onCancelResume}
                        focusInside={focusInHold}
                    />
                )}
            </div>
        </div>
    );
}
