import { useEffect, useId, useRef } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { ipcErrorText } from '@/api/ipcErrorText';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';
import { ToneNote } from '@/components/ui/ToneNote';
import { formatDuration } from '@/utils/formatters';
import { useTick } from '@/hooks/useTick';

import type { ExecutionMode } from '../../../core/autovote/state';
import type { StopResult } from '../../../core/autovote/runGate';

/**
 * Isolated 1Hz countdown of the startup hold on an auto-resume, so the tick
 * re-renders only this node. A late timer clamps at zero.
 */
function ResumeCountdown({ startAt }: { startAt: number }) {
    const { t } = useTranslation();
    const now = useTick(1000);
    const remaining = Math.max(0, Math.ceil(startAt / 1000) - now);
    return <span>{t('app.resumeHold', { time: formatDuration(remaining, { includeSeconds: true }) })}</span>;
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
                <button
                    className="btn btn-sm btn-neutral max-sm:min-h-10"
                    aria-describedby={noteId}
                    onClick={() => void onStartNow()}
                >
                    {t('app.resumeStartNow')}
                </button>
                <button
                    className="btn btn-sm max-sm:min-h-10"
                    aria-describedby={noteId}
                    onClick={() => void onCancelResume()}
                >
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

// What the controller is doing → the translation key of its label (the English text is EXECUTION_MODE_LABELS).
const MODE_LABEL_KEYS: Record<ExecutionMode, string> = {
    stopped: 'app.modeStopped',
    armed: 'app.modeArmed',
    voting: 'app.modeVoting',
};

/**
 * The line under the mode label about the last full Stop and a Run that is on its way: a Stop the computer has not confirmed
 * (a paired phone), or one that was not saved (stopped on this device only, which says to press Stop again).
 */
function StopNote({
    lastStop,
    executionMode,
    startPending,
}: {
    lastStop: StopResult | null;
    executionMode: ExecutionMode;
    startPending: boolean;
}) {
    const { t } = useTranslation();
    if (lastStop?.outcome === 'requested') return <p className="text-sm mt-1">{t('app.stopRequested')}</p>;
    // Only while still stopped: once the mode shows what came of the Run, the mode says it (a local Run runs its
    // first cycle with the mode already voting).
    if (startPending && executionMode === 'stopped') {
        return <p className="text-sm mt-1">{t('app.startRequested')}</p>;
    }
    if (lastStop?.outcome === 'stopped-locally' && executionMode === 'stopped') {
        // Only while stopped: a later Run is a new session, and this Stop's result no longer says anything about it.
        return (
            <div role="alert" className="alert alert-warning mt-3 text-sm items-start">
                <div className="space-y-1">
                    <p className="font-semibold">{t('app.stopLocalTitle')}</p>
                    <p>{t('app.stopLocalDetail')}</p>
                </div>
            </div>
        );
    }
    return null;
}

/**
 * Autovote controls: the execution mode in a polite status region, and the controls that fit it. Stopped: Start. Armed (a
 * scenario is active and voting is paused): Resume voting, and Stop all automation. Voting: Stop all automation. Stop all
 * automation always asks for a full Stop, and is kept in view while a Run is on its way and after a Stop that was not saved.
 * While an auto-resume is held at launch (`pendingStartAt`) the buttons give way to a countdown with Start now / Don't
 * resume, so there is never a second Start. The activity status (Running, Error, last run, cycles) is a separate line: it
 * never stands for the mode.
 */
export function AutoVoteControls({
    executionMode,
    lastStop,
    startPending = false,
    status,
    statusClass,
    error = null,
    lastRun,
    cycles,
    onStart,
    onStop,
    autoJoinActive,
    pendingStartAt,
    onStartNow,
    onCancelResume,
}: {
    executionMode: ExecutionMode;
    /** what the last full Stop came to, or null when none was given */
    lastStop: StopResult | null;
    /** a Run / Resume was sent to a host that has not answered yet (the paired phone) */
    startPending?: boolean;
    status: string;
    statusClass: string;
    /** why the last cycle failed (the reducer's error); shown while the status is Error */
    error?: string | null;
    lastRun: string | null;
    cycles: number;
    /** Start (stopped) or Resume voting (armed) */
    onStart: () => void | Promise<void>;
    /** Stop all automation */
    onStop: () => void | Promise<void>;
    autoJoinActive: boolean;
    pendingStartAt: number | null;
    onStartNow: () => void | Promise<void>;
    onCancelResume: () => void | Promise<void>;
}) {
    const { t } = useTranslation();
    const pending = pendingStartAt !== null;
    const primaryRef = useRef<HTMLButtonElement>(null);
    const focusInHold = useRef(false);
    const focusInControls = useRef(false);
    // The notice just went away (Start now, Don't resume, or the timer): if focus
    // was in it, it would drop to the page, so hand it to the primary control (WCAG 2.4.3).
    useEffect(() => {
        if (pending || !focusInHold.current) return;
        focusInHold.current = false;
        primaryRef.current?.focus();
    }, [pending]);
    // A transition swaps the buttons (Stop gives way to Start, Start to Stop): focus that was on one goes to the first of the
    // new set, never to the page. Removing a focused node fires no blur, so `focusInControls` still says it was there.
    useEffect(() => {
        if (focusInControls.current) primaryRef.current?.focus();
    }, [executionMode, startPending]);

    const canStop = executionMode !== 'stopped' || startPending || lastStop?.outcome === 'stopped-locally';
    const canStart = !startPending && executionMode !== 'voting';
    const startKey = executionMode === 'armed' ? 'app.resumeVoting' : 'app.startAutoVote';
    const stopButton = (
        <button
            key="stop"
            ref={canStart ? undefined : primaryRef}
            className="btn btn-sm btn-error max-sm:min-h-10"
            onClick={() => void onStop()}
        >
            <StrokeIcon className="w-4 h-4 mr-1" d={ICON_PATHS.close} />
            {t('app.stopAllAutomation')}
        </button>
    );

    return (
        <div className="card bg-base-100 shadow-md mb-4">
            <div className="card-body p-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                    {/* Controls — hidden while a held resume offers Start now */}
                    {!pending && (
                        <div
                            className="flex flex-wrap gap-2"
                            onFocus={() => {
                                focusInControls.current = true;
                            }}
                            onBlur={() => {
                                focusInControls.current = false;
                            }}
                        >
                            {canStart && (
                                <button
                                    key="start"
                                    ref={primaryRef}
                                    className="btn btn-sm btn-neutral max-sm:min-h-10"
                                    onClick={() => void onStart()}
                                >
                                    <StrokeIcon className="w-4 h-4 mr-1" d={ICON_PATHS.smile} />
                                    {t(startKey)}
                                </button>
                            )}
                            {canStop && stopButton}
                        </div>
                    )}

                    {/* Status Info */}
                    <div className="flex flex-wrap items-center gap-4">
                        {/* What the controller is doing: a polite region, so a change of mode is announced */}
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{t('app.modeLabel')}</span>
                            <span className="badge badge-sm badge-outline" role="status" aria-live="polite">
                                {t(MODE_LABEL_KEYS[executionMode])}
                            </span>
                        </div>

                        {/* Status Badge */}
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{t('app.status')}</span>
                            <span className={`badge badge-sm ${pending ? 'badge-warning' : statusClass}`} role="status">
                                {pending ? t('app.statusWaiting') : t(STATUS_LABEL_KEYS[status] ?? 'app.statusError')}
                            </span>
                            {/* Auto-join is a property of the voting autovote, so it
                                sits next to the status. Shown only while the voting
                                stages run — that is when the join pre-step
                                actually executes, and showing it while they are
                                off would wrongly imply background joining. Own
                                polite live region so arming/disarming mid-session
                                is announced. */}
                            {autoJoinActive && executionMode === 'voting' && (
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

                {/* In armed mode a scenario may still act: say so where it is announced */}
                <div aria-live="polite">
                    {executionMode === 'armed' && <p className="text-sm mt-2">{t('app.modeArmedNote')}</p>}
                    <StopNote lastStop={lastStop} executionMode={executionMode} startPending={startPending} />
                </div>

                {!pending && status === 'Error' && error && (
                    <ToneNote tone="error" role="alert" className="text-sm mt-2">
                        {ipcErrorText(error, t, 'errors.votingFailed')}
                    </ToneNote>
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
