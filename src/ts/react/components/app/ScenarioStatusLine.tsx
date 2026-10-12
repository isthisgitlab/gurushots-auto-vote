import { useTranslation } from '@/contexts/TranslationContext';
import { formatDuration } from '@/utils/formatters';
import { useTick } from '@/hooks/useTick';
import { interp } from '@/utils/interp';
import type * as useScenarioStatusModule from '@/api/useScenarioStatus';

const AGAIN_KEY = {
    phase: 'app.scenarioStatusAgainPhase',
    reset: 'app.scenarioStatusAgainReset',
    day: 'app.scenarioStatusAgainDay',
} as const;

type Summary = NonNullable<ReturnType<typeof useScenarioStatusModule.useScenarioStatus>>;

// What to say besides where the plan is: a spend that got no answer (and, after a stop, a problem that came later),
// else the last problem.
function Notice({ status, compact }: { status: Summary; compact: boolean }) {
    const { t } = useTranslation();
    const { spendUnclear, lastError } = status;
    const spend = spendUnclear
        ? interp(t(spendUnclear.stopped ? 'app.scenarioStatusSpendStopped' : 'app.scenarioStatusSpendUnclear'), {
              action: t(`app.sbAct_${spendUnclear.action}`),
              again: t(AGAIN_KEY[spendUnclear.again]),
              id: spendUnclear.challengeId,
          })
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
                        <div key={text} className={`text-warning ${compact ? 'line-clamp-2' : ''}`} role="status">
                            {text}
                        </div>
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
}: {
    status: ReturnType<typeof useScenarioStatusModule.useScenarioStatus>;
    compact?: boolean;
}) {
    const { t } = useTranslation();
    const now = useTick(1000, Boolean(status?.nextWakeAt));
    if (!status) return null;

    if (status.missing || status.corrupt) {
        const key = status.missing ? 'app.scenarioStatusMissing' : 'app.scenarioStatusCorrupt';
        return (
            <div className="text-xs text-warning" role="status">
                <span aria-hidden="true">⚠</span> {interp(t(key), { name: status.name })}
            </div>
        );
    }

    const phase = status.started
        ? interp(t('app.scenarioStatusPhase'), { phase: status.phase })
        : interp(t('app.scenarioStatusNotStarted'), { phase: status.phase });
    const remaining = status.nextWakeAt ? status.nextWakeAt - now : null;
    const next =
        remaining !== null && remaining > 0
            ? interp(t('app.scenarioStatusNext'), { time: formatDuration(remaining, { includeSeconds: true }) })
            : null;

    return (
        <div className={compact ? 'text-xs text-base-content/70' : 'text-xs bg-base-200 rounded p-2 space-y-1'}>
            <div className={compact ? 'truncate' : undefined} title={status.name}>
                <span aria-hidden="true">🧭</span> {status.name} · {phase}
                {next && <> · {next}</>}
            </div>
            <Notice status={status} compact={compact} />
        </div>
    );
}
