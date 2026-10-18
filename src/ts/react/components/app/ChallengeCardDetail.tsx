import { useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { formatEndTime, getLevelStatus, isBoostAvailable, statusText } from '@/utils/formatters';
import { getNextLevelInfo } from '@/utils/challengeCardView';
import { sanitizeWelcomeMessage } from '@/utils/sanitizeWelcomeMessage';
import { statusBadgeClass, toneBadgeClass } from '@/utils/statTone';
import { Countdown } from './Countdown';
import type { TimeRemaining } from './Countdown';
import { DeadlineTimeline } from './DeadlineTimeline';
import { ScenarioStatusPanel } from './ScenarioStatusPanel';
import { EntryBadge } from './EntryBadge';
import { ChallengeBadgeRow } from './ChallengeBadgeRow';
import { ChallengeTagBadges } from './ChallengeKindBadges';
import { stringTags } from '../../../format/challengeListing';
import { CardDensityToggle } from './CardDensityToggle';
import { FillButtons } from './ChallengeCardActions';
import { InlineError } from '@/components/ui/InlineError';
import * as ipc from '@/api/ipc';
import { ipcErrorText } from '@/api/ipcErrorText';
import { interp } from '@/utils/interp';
import { canStillFire, livePinKindOf, unusablePins } from '../../../voting/entryPins';
import { challengePageUrl } from '@/utils/challengePageUrl';

import type { ComponentChildren } from 'preact';
import type { Bankroll, Challenge, RankingTotal } from '../../../types/gurushots';
import type { ChallengeCardView } from './ChallengeCard';
import type { ChallengeCardActionSet } from './ChallengeCardActions';
import type { OpenSwapPick } from './SwapEntryButton';
import type { ChallengeBadgeRowProps } from './ChallengeBadgeRow';
import type { DeadlineAction } from './DeadlineTimeline';
import type * as useSwapBacksModule from '@/api/useSwapBacks';
import type * as useEntryPinsModule from '@/api/useEntryPins';
import type { EntryPinKind } from '../../../types/settings';
import type * as useScenarioStatusModule from '@/api/useScenarioStatus';

export type SwapBackOffers = ReturnType<typeof useSwapBacksModule.useSwapBacks>;
export type EntryPinsState = ReturnType<typeof useEntryPinsModule.useEntryPins>;

// The value line of a stat cell; Ends alone drops to text-xs, since a long date string needs the room.
const STAT_VALUE = 'text-sm font-semibold tabular-nums';

/**
 * One labelled cell of the detailed card's stat grids.
 */
function StatCell({ label, children }: { label: string; children: ComponentChildren }) {
    return (
        <div className="bg-base-200 rounded-box p-2 text-center flex flex-col gap-1">
            <div className="text-xs font-medium text-base-content/70">{label}</div>
            {children}
        </div>
    );
}

/**
 * Title, welcome message, badges, challenge link and the header actions. The
 * header stacks vertically: the title gets the full card width (so it
 * truncates far less), and the action buttons sit on their own row beneath it,
 * wrapping as needed rather than squeezing the title.
 */
function DetailHeader({
    challenge,
    badgeRowProps,
    actions,
    hasCompactOverride,
    onToggleCompact,
}: {
    challenge: Challenge;
    badgeRowProps: ChallengeBadgeRowProps;
    actions: ChallengeCardActionSet;
    hasCompactOverride: boolean;
    onToggleCompact: () => void | Promise<void>;
}) {
    const sanitizedWelcome = useMemo(
        () => sanitizeWelcomeMessage(challenge.welcome_message),
        [challenge.welcome_message],
    );

    // Only reachable from the URL row, which renders only when challenge.url is set. The slug comes off the network
    // and goes into a URL path: anything but word characters and hyphens opens the generic challenges page instead.
    const handleOpenUrl = () => {
        void ipc.callOrNull(() => ipc.openExternalUrl(challengePageUrl(challenge.url)));
    };

    return (
        <div className="flex flex-col gap-2">
            <div className="min-w-0">
                <h3 className="font-bold text-base wrap-anywhere">{challenge.title}</h3>
                {/* Welcome message. wrap-anywhere wraps the full text, including long unbroken words and URLs, so it never forces the card wider. sanitizeWelcomeMessage strips medium-editor toolbar leakage and allowlists safe tags. */}
                {sanitizedWelcome && (
                    <div
                        className="text-xs text-base-content/70 wrap-anywhere"
                        dangerouslySetInnerHTML={{ __html: sanitizedWelcome }} /* aislop-ignore-line -- sanitized */
                    />
                )}
                <ChallengeBadgeRow {...badgeRowProps} />
                {challenge.url && (
                    <div className="text-xs text-base-content/70 mt-1">
                        <button
                            onClick={handleOpenUrl}
                            className="font-mono hover:text-info hover:underline text-left min-h-6 py-1"
                        >
                            {challengePageUrl(challenge.url).replace('https://', '')}
                        </button>
                    </div>
                )}
            </div>
            <div className="flex flex-wrap gap-1 shrink-0">
                {actions.voteButton}
                {actions.runButton}
                <div className="flex flex-wrap gap-1 ml-auto">
                    <CardDensityToggle isCompact={false} hasOverride={hasCompactOverride} onToggle={onToggleCompact} />
                    {actions.settingsButton}
                </div>
            </div>
            {actions.pressError && <InlineError onDismiss={actions.clearPressError}>{actions.pressError}</InlineError>}
        </div>
    );
}

/**
 * User progress — full bar + level + next-level info. Rendered only once the
 * member has votes in the challenge.
 */
function UserProgressPanel({ challenge, userProgress }: { challenge: Challenge; userProgress: RankingTotal }) {
    const { t } = useTranslation();
    const progressLabelId = useId();
    const nextLevelInfo = getNextLevelInfo(challenge);
    const { colorClass, progressClass } = getLevelStatus(
        userProgress.level as number,
        userProgress.level_name as string,
    );

    return (
        <div className="bg-base-200 rounded p-2">
            <div className="flex justify-between items-center mb-1">
                <span id={progressLabelId} className="text-xs font-medium">
                    {t('app.yourProgress')}
                </span>
                <span className={`badge badge-sm ${colorClass}`}>
                    {userProgress.level_name} {userProgress.level}
                </span>
            </div>
            <div className="flex justify-between text-xs mb-1">
                <span>
                    {t('app.rank')} {userProgress.rank} {t('app.of')} {challenge.players}
                </span>
                <span>
                    {userProgress.votes} {t('app.votes')}
                </span>
            </div>
            <div className="flex items-center gap-2">
                <progress
                    className={`progress ${progressClass} w-full`}
                    value={userProgress.percent}
                    max="100"
                    aria-labelledby={progressLabelId}
                />
                {/* The bar alone says it by colour and length; the progress element already announces the value. */}
                {userProgress.percent !== undefined && (
                    <span className="text-xs tabular-nums shrink-0" aria-hidden="true">
                        {Math.round(userProgress.percent)}%
                    </span>
                )}
            </div>
            {challenge.type !== 'flash' && (
                <div className="text-xs text-base-content/70 mt-1">{userProgress.next_message}</div>
            )}
            {nextLevelInfo && (
                <div className="text-xs text-base-content/70 mt-1">
                    {t('app.next')}: {nextLevelInfo.levelName} ({nextLevelInfo.votesNeeded} {t('app.votesNeeded')})
                </div>
            )}
        </div>
    );
}

/**
 * 6-cell live-state grid (time, end, exposure, boost, turbo, entries) with the
 * cell-placed actions — stacks 2-up on phones, 3-up on small tablets, 6-up on
 * desktop.
 */
function StatusCells({
    challenge,
    view,
    timeRemaining,
    timezone,
    actions,
}: {
    challenge: Challenge;
    view: ChallengeCardView;
    timeRemaining: TimeRemaining;
    timezone: string;
    actions: ChallengeCardActionSet;
}) {
    const { t } = useTranslation();
    const { turboError, fillError, clearTurboError, clearFillError } = actions;

    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 text-xs">
            <StatCell label={t('app.time')}>
                <div className={STAT_VALUE}>
                    <Countdown source={timeRemaining} closeTime={challenge.close_time} />
                </div>
            </StatCell>
            <StatCell label={t('app.ends')}>
                <div className="text-xs font-semibold tabular-nums">
                    {formatEndTime(challenge.close_time, timezone)}
                </div>
            </StatCell>
            <StatCell label={t('app.exposure')}>
                <div className={STAT_VALUE}>
                    <span className={toneBadgeClass(view.exposureTone, 'md')}>{view.exposureFactor}%</span>
                </div>
                {actions.fillExposureButton}
            </StatCell>
            <StatCell label={t('app.boost')}>
                <div className={STAT_VALUE}>
                    <span className={statusBadgeClass(view.boostStatus.colorClass, 'md')}>
                        {statusText(view.boostStatus, t)}
                    </span>
                </div>
                {actions.keyUnlockButton}
            </StatCell>
            <StatCell label={t('app.turbo')}>
                <div className={STAT_VALUE}>
                    <span className={statusBadgeClass(view.turboStatus.colorClass, 'md')}>
                        {statusText(view.turboStatus, t)}
                    </span>
                </div>
                {actions.earnTurboButton}
                {turboError && <InlineError onDismiss={clearTurboError}>{turboError}</InlineError>}
            </StatCell>
            <StatCell label={t('app.yourEntries')}>
                <div className={STAT_VALUE}>
                    {view.entries.length}/{challenge.max_photo_submits}
                </div>
                {view.canFill && (
                    <div className="flex flex-wrap gap-2 justify-center">
                        <FillButtons {...actions.fillButtonProps} />
                    </div>
                )}
                {fillError && <InlineError onDismiss={clearFillError}>{fillError}</InlineError>}
            </StatCell>
        </div>
    );
}

/**
 * A stored pin that cannot take its feature right now (its photo left the challenge, or carries the other
 * feature), with a way to clear it. Only while the feature can still fire: a spent feature's pin is inert.
 * The button is inert while a pin write is in flight, like the pin toggles: aria-disabled, never `disabled`.
 */
function DanglingPinNote({
    kind,
    state,
    busy,
    onClear,
}: {
    kind: EntryPinKind;
    state: 'gone' | 'conflict';
    busy: boolean;
    onClear: (button: HTMLButtonElement) => void | Promise<void>;
}) {
    const { t } = useTranslation();
    const text = interp(t(state === 'gone' ? 'app.pinGoneNote' : 'app.pinConflictNote'), {
        kind: t(kind === 'boost' ? 'app.boost' : 'app.turbo'),
        other: t(kind === 'boost' ? 'app.turbo' : 'app.boost'),
    });
    return (
        <div className="alert alert-info py-2 text-xs" role="status">
            <span>{text}</span>
            <button
                type="button"
                className={`btn btn-ghost btn-sm${busy ? ' btn-disabled' : ''}`}
                aria-disabled={busy}
                aria-busy={busy}
                onClick={(event) => {
                    if (!busy) void onClear(event.currentTarget);
                }}
            >
                {t('app.pinClear')}
            </button>
        </div>
    );
}

/** Focus is nowhere: on the page itself, or on an element that has just been removed. */
const focusIsLost = (): boolean => {
    const active = document.activeElement;
    return active === null || active === document.body || !active.isConnected;
};

/**
 * Entry details — entry-level boost / turbo badges and actions, the pin toggles and the notes for pins that no
 * longer apply.
 */
function EntryDetails({
    challenge,
    view,
    swapBacks,
    entryPins,
    bankroll,
    onVoteComplete,
    onCurrencySpent,
    onChooseSwap,
    timezone,
}: {
    challenge: Challenge;
    view: ChallengeCardView;
    swapBacks: SwapBackOffers;
    entryPins: EntryPinsState;
    bankroll: Bankroll | null;
    onVoteComplete: () => void;
    onCurrencySpent: () => void;
    onChooseSwap: OpenSwapPick;
    timezone: string;
}) {
    const { t } = useTranslation();
    const { pins, togglePin, setPin, loading: pinBusy, error: pinError, clearError: clearPinError } = entryPins;
    const canPin = { boost: canStillFire(challenge, 'boost'), turbo: canStillFire(challenge, 'turbo') };
    const detailsRef = useRef<HTMLDivElement>(null);
    const labelId = useId();
    const clearedButtonRef = useRef<HTMLButtonElement | null>(null);

    // A cleared pin's note unmounts with the focused button inside it: focus would drop to <body>, so it moves to the
    // section instead. The note can unmount well after the write resolves (a settings-changed read supersedes the
    // write's own), hence the check runs after every render rather than after the write. Focus that has landed on
    // another element since is never moved: a record is forgotten by a focusout from the button after which it no
    // longer holds focus (while it is still in the page) or by a focusin on any other element, so a failed clear (the
    // note, and focus, stay where they are) followed by the user moving on never acts later. A focusout from the
    // button's own removal (some engines fire one) is left to the layout effect, which has already run by the time the
    // deferred check sees the button gone. The record survives the window losing focus, and focus can move without a
    // focusout from the button (a dialog focusing its first button while the window is unfocused): the focusin that
    // follows when the window regains focus forgets the record, and the layout effect moves focus only if it is
    // actually lost. One ordering can still act: only the two focus moves need to happen while the window is in the
    // background (a silent move to another element, then focus to <body>); when the window regains focus with <body>
    // active no element gets a focusin, so a later unmount — even in the foreground, while focus stays on <body> —
    // moves focus to the section instead of nothing.
    useEffect(() => {
        const forgetOnBlur = (event: FocusEvent) => {
            const button = clearedButtonRef.current;
            if (!button || event.target !== button) return;
            queueMicrotask(() => {
                // Still focused and in the page: the whole window lost focus, not just the button. A newer record
                // (another button) is not this microtask's to wipe — a race only script can produce (a focus() and a
                // click() in one task, as tests do): a microtask checkpoint follows every listener the browser
                // dispatches, so this microtask runs before any later click handler, and only a script-called
                // focus() keeps the stack busy.
                if (clearedButtonRef.current === button && button.isConnected && document.activeElement !== button) {
                    clearedButtonRef.current = null;
                }
            });
        };
        const forgetOnFocusElsewhere = (event: FocusEvent) => {
            if (clearedButtonRef.current && event.target !== clearedButtonRef.current) clearedButtonRef.current = null;
        };
        document.addEventListener('focusout', forgetOnBlur);
        document.addEventListener('focusin', forgetOnFocusElsewhere);
        return () => {
            document.removeEventListener('focusout', forgetOnBlur);
            document.removeEventListener('focusin', forgetOnFocusElsewhere);
        };
    }, []);

    useLayoutEffect(() => {
        const button = clearedButtonRef.current;
        if (!button || button.isConnected) return;
        clearedButtonRef.current = null;
        if (focusIsLost()) detailsRef.current?.focus({ preventScroll: true });
    });

    // Some engines (WebKit, Firefox on macOS) do not focus a button on a mouse click: nothing to restore is
    // recorded (in WebKit focus is already on the group).
    const clearPin = async (kind: EntryPinKind, button: HTMLButtonElement) => {
        clearedButtonRef.current = document.activeElement === button ? button : null;
        await setPin(kind, null);
    };

    return (
        <div ref={detailsRef} tabIndex={-1} role="group" aria-labelledby={labelId}>
            <div className="text-xs text-base-content/70 mb-1">
                <span id={labelId}>{t('app.entryDetails')}</span>:
            </div>
            <div className="flex flex-col items-start gap-1">
                {view.entries.map((entry) => (
                    <EntryBadge
                        key={entry.id}
                        entry={entry}
                        challengeId={challenge.id}
                        boostAvailable={isBoostAvailable(view.boostStatus)}
                        turboAvailable={view.member.turbo?.state === 'WON'}
                        onBoostApplied={onVoteComplete}
                        onTurboApplied={onVoteComplete}
                        swapAvailable={view.swapAvailable}
                        bankroll={bankroll}
                        onSwapped={onCurrencySpent}
                        onChooseSwap={onChooseSwap}
                        swapBack={swapBacks.find((r) => r.currentId === String(entry.id)) ?? null}
                        pin={{
                            pins,
                            canPin,
                            livePin: livePinKindOf(challenge, entry, pins),
                            busy: pinBusy,
                            onToggle: togglePin,
                        }}
                        timezone={timezone}
                    />
                ))}
            </div>
            {/* Manual Only: a pin only steers the automatic spends, which do not run, so its notes stay hidden. */}
            {(view.manualOnly ? [] : unusablePins(challenge, pins)).map(({ kind, state }) => (
                <DanglingPinNote
                    key={kind}
                    kind={kind}
                    state={state}
                    busy={pinBusy}
                    onClear={(button) => clearPin(kind, button)}
                />
            ))}
            {pinError && (
                <InlineError className="mt-1" onDismiss={clearPinError}>
                    {ipcErrorText(pinError, t)}
                </InlineError>
            )}
        </div>
    );
}

/**
 * The detailed challenge card body: every stat and every action. All values
 * are derived by the parent ChallengeCard (see utils/challengeCardView) and
 * passed in, so this layout and the compact tile never disagree.
 */
export function ChallengeCardDetail({
    challenge,
    view,
    badgeRowProps,
    timeRemaining,
    timezone,
    actions,
    hasCompactOverride,
    onToggleCompact,
    boostWarning,
    turboWarning,
    deadlineActions,
    scenarioStatus,
    swapBacks,
    entryPins,
    bankroll,
    onVoteComplete,
    onCurrencySpent,
}: {
    challenge: Challenge;
    view: ChallengeCardView;
    badgeRowProps: ChallengeBadgeRowProps;
    timeRemaining: TimeRemaining;
    timezone: string;
    actions: ChallengeCardActionSet;
    hasCompactOverride: boolean;
    onToggleCompact: () => void | Promise<void>;
    boostWarning: string | null;
    turboWarning: string | null;
    deadlineActions: DeadlineAction[];
    scenarioStatus: ReturnType<typeof useScenarioStatusModule.useScenarioStatus>;
    swapBacks: SwapBackOffers;
    entryPins: EntryPinsState;
    bankroll: Bankroll | null;
    onVoteComplete: () => void;
    onCurrencySpent: () => void;
}) {
    const { t } = useTranslation();
    const { userProgress } = view;
    const cardTags = stringTags(challenge);

    return (
        <div className="space-y-2">
            <DetailHeader
                challenge={challenge}
                badgeRowProps={badgeRowProps}
                actions={actions}
                hasCompactOverride={hasCompactOverride}
                onToggleCompact={onToggleCompact}
            />

            {/* Challenge Statistics — stacks 2-up on phones, 4-up on tablets+. */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <StatCell label={t('app.entries')}>
                    <div className={STAT_VALUE}>{challenge.entries.toLocaleString()}</div>
                </StatCell>
                <StatCell label={t('app.players')}>
                    <div className={STAT_VALUE}>{challenge.players.toLocaleString()}</div>
                </StatCell>
                <StatCell label={t('app.votes')}>
                    <div className={STAT_VALUE}>{(challenge.votes ?? 0).toLocaleString()}</div>
                </StatCell>
                <StatCell label={t('app.prize')}>
                    <div className={STAT_VALUE}>{challenge.prizes_worth}</div>
                </StatCell>
            </div>

            {userProgress && (userProgress.votes ?? 0) > 0 && (
                <UserProgressPanel challenge={challenge} userProgress={userProgress} />
            )}

            <StatusCells
                challenge={challenge}
                view={view}
                timeRemaining={timeRemaining}
                timezone={timezone}
                actions={actions}
            />

            {/* Challenge Tags */}
            {cardTags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    <ChallengeTagBadges tags={cardTags} />
                </div>
            )}

            {view.entries.length > 0 && (
                <EntryDetails
                    challenge={challenge}
                    view={view}
                    swapBacks={swapBacks}
                    entryPins={entryPins}
                    bankroll={bankroll}
                    onVoteComplete={onVoteComplete}
                    onCurrencySpent={onCurrencySpent}
                    onChooseSwap={actions.openSwapPick}
                    timezone={timezone}
                />
            )}

            {/* Boost/turbo conflict — a boost (or won turbo) is available but every
                entry has the other feature or is pinned for it, so it can't be
                placed. The compact tile shows the same state as a one-line note. */}
            {(
                [
                    ['boost', boostWarning],
                    ['turbo', turboWarning],
                ] as const
            ).map(
                ([kind, warning]) =>
                    warning && (
                        // Keyed on which feature it is about, so a reworded warning is not announced as a new one.
                        <div key={kind} className="alert alert-warning py-2 text-xs" role="alert">
                            <span>{warning}</span>
                        </div>
                    ),
            )}

            {/* Advisory timeline of the automation's upcoming deadline
                actions (the compact tile shows only the next one). */}
            <DeadlineTimeline actions={deadlineActions} />
            <ScenarioStatusPanel status={scenarioStatus} challenge={challenge} />
        </div>
    );
}
