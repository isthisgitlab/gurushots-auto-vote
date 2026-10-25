import { useTranslation } from '@/contexts/TranslationContext';
import { ToneNote } from '@/components/ui/ToneNote';
import { formatDuration } from '@/utils/formatters';
import { useTick } from '@/hooks/useTick';
import { interp } from '@/utils/interp';
import type * as useScenarioStatusModule from '@/api/useScenarioStatus';

const AGAIN_KEY = {
    phase: 'app.scenarioStatusAgainPhase',
    reset: 'app.scenarioStatusAgainReset',
    day: 'app.scenarioStatusAgainDay',
} as const;

// The notice for progress that cannot be read — the whole file, or this challenge's record — or that is not read in
// yet, on the card and (short) on the compact tile.
const CORRUPT_KEY = {
    unloaded: ['app.scenarioStatusUnloaded', 'app.scenarioStatusUnloadedShort'],
    unloadedService: ['app.scenarioStatusUnloadedService', 'app.scenarioStatusUnloadedServiceShort'],
    file: ['app.scenarioStatusCorrupt', 'app.scenarioStatusCorruptShort'],
    record: ['app.scenarioStatusCorruptRecord', 'app.scenarioStatusCorruptRecordShort'],
} as const;

// The notice for a spend that is being checked on, by what the doubt came from. Under Manual Only the next cycle
// checks nothing, so the text says the check waits for the switch to go off.
const CHECKED_KEY = {
    unclear: 'app.scenarioStatusSpendUnclear',
    pending: 'app.scenarioStatusSpendUnclearPending',
} as const;
const CHECKED_MANUAL_KEY = {
    unclear: 'app.scenarioStatusSpendUnclearManual',
    pending: 'app.scenarioStatusSpendUnclearPendingManual',
} as const;

// The notice for a rule that was stopped, on the card and (short) on the compact tile, by what the stop came from.
const STOPPED_KEY = [
    { unclear: 'app.scenarioStatusSpendStopped', pending: 'app.scenarioStatusSpendStoppedPending' },
    { unclear: 'app.scenarioStatusSpendStoppedShort', pending: 'app.scenarioStatusSpendStoppedPendingShort' },
] as const;

type Summary = NonNullable<ReturnType<typeof useScenarioStatusModule.useScenarioStatus>>;

function ResetButton({ label, onReset }: { label: string; onReset: () => void }) {
    const { t } = useTranslation();
    return (
        <button type="button" className="btn btn-error btn-sm max-sm:min-h-10" onClick={onReset}>
            {t(label)}
        </button>
    );
}

// A scenario that is gone, or whose saved progress cannot be read: nothing runs, and the card says why.
function Unavailable({
    status,
    compact,
    onReset,
}: {
    status: Summary;
    compact: boolean;
    onReset: (() => void) | undefined;
}) {
    const { t } = useTranslation();
    // Not loaded in this window: where the background service is installed it owns the plans (and runs them if it is
    // on); without it the plans are paused.
    const kind = status.corrupt === 'unloaded' && status.serviceRuns ? 'unloadedService' : status.corrupt;
    const corruptKeys = kind ? CORRUPT_KEY[kind] : null;
    const key = corruptKeys ? corruptKeys[compact ? 1 : 0] : 'app.scenarioStatusMissing';
    // The button's own label, which the compact tile's notice names (the tile has no button of its own).
    const resetLabel = status.corrupt === 'file' ? 'app.scenarioResetAll' : 'app.scenarioReset';
    return (
        <div className="text-xs space-y-1">
            <ToneNote tone="warning" as="div" role="status">
                {interp(t(key), { name: status.name, details: t('app.details'), reset: t(resetLabel) })}
            </ToneNote>
            {status.corrupt && status.corrupt !== 'unloaded' && onReset && (
                <ResetButton label={resetLabel} onReset={onReset} />
            )}
        </div>
    );
}

// What to say besides where the plan is: a spend that got no answer (and, after a stop, a problem that came later),
// else the last problem.
function Notice({ status, compact }: { status: Summary; compact: boolean }) {
    const { t } = useTranslation();
    const { spendUnclear, lastError } = status;
    // The compact tile clamps its notices, so a stopped rule gets a short one there, whole, with the control to press
    // first; the card has the rest.
    const spend = spendUnclear
        ? interp(
              t(
                  spendUnclear.stopped
                      ? STOPPED_KEY[compact ? 1 : 0][spendUnclear.origin]
                      : (status.manualOnly ? CHECKED_MANUAL_KEY : CHECKED_KEY)[spendUnclear.origin],
              ),
              {
                  action: t(`app.sbAct_${spendUnclear.action}`),
                  hint: interp(t('app.scenarioStatusResetHint'), {
                      again: t(AGAIN_KEY[spendUnclear.again]),
                      id: spendUnclear.challengeId,
                  }),
                  details: t('app.details'),
              },
          )
        : null;
    const problem =
        lastError && (!spendUnclear || spendUnclear.newerProblem)
            ? interp(t('app.scenarioStatusProblem'), { message: lastError })
            : null;
    return (
        <>
            {[spend, problem].map(
                (text) =>
                    text && (
                        <ToneNote
                            key={text}
                            tone="warning"
                            as="div"
                            role="status"
                            className={compact ? 'line-clamp-2' : ''}
                        >
                            {text}
                        </ToneNote>
                    ),
            )}
        </>
    );
}

/**
 * Where a challenge is in its scenario (useScenarioStatus): the scenario, its
 * phase and when it next looks — plus the last problem, so a stuck step is
 * visible on the card rather than only in the logs. Renders nothing for a
 * challenge without a scenario. `compact` is the one-line tile variant.
 */
export function ScenarioStatusLine({
    status,
    compact = false,
    onReset,
}: {
    status: ReturnType<typeof useScenarioStatusModule.useScenarioStatus>;
    compact?: boolean;
    /** Offers the reset, for the notices that say a reset is the way on (a stopped rule, unreadable progress). */
    onReset?: () => void;
}) {
    const { t } = useTranslation();
    const now = useTick(1000, Boolean(status?.nextWakeAt));
    if (!status) return null;

    if (status.missing || status.corrupt) return <Unavailable status={status} compact={compact} onReset={onReset} />;

    // A plan that has not started starts on the next run, except under Manual Only, which runs nothing until it is off.
    const phase = status.started
        ? interp(t('app.scenarioStatusPhase'), { phase: status.phase })
        : interp(t(status.manualOnly ? 'app.scenarioStatusNotStartedManual' : 'app.scenarioStatusNotStarted'), {
              phase: status.phase,
          });
    const remaining = status.nextWakeAt ? status.nextWakeAt - now : null;
    // Manual Only pauses the plan: no step runs and no check is due, so the line says so instead of a countdown.
    // A plan that has not started already says it starts once Manual Only is off, so it adds no paused suffix.
    const next = status.manualOnly
        ? status.started
            ? t(compact ? 'app.scenarioStatusPausedManualShort' : 'app.scenarioStatusPausedManual')
            : null
        : remaining !== null && remaining > 0
          ? interp(t('app.scenarioStatusNext'), { time: formatDuration(remaining, { includeSeconds: true }) })
          : null;

    return (
        <div className={compact ? 'text-xs text-base-content/70' : 'text-xs bg-base-200 rounded p-2 space-y-1'}>
            <div className={compact ? 'flex gap-1' : undefined} title={status.name}>
                {/* Compact: only the name gives way, so the phase and countdown stay readable. */}
                <span className={compact ? 'truncate min-w-0' : undefined}>
                    <span aria-hidden="true">🧭</span> {status.name}
                </span>
                <span className={compact ? 'shrink-0' : undefined}>
                    {' · '}
                    {phase}
                    {next && <> · {next}</>}
                </span>
            </div>
            <Notice status={status} compact={compact} />
            {status.spendUnclear?.stopped && onReset && <ResetButton label="app.scenarioReset" onReset={onReset} />}
        </div>
    );
}
