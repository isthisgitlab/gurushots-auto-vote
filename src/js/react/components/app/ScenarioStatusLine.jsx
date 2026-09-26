import { useTranslation } from '@/contexts/TranslationContext';
import { formatDuration } from '@/utils/formatters';
import { useTick } from '@/hooks/useTick';
import { interp } from '@/utils/interp';

/**
 * Where a challenge is in its scenario (useScenarioStatus): the scenario, its
 * phase and when it next looks — plus the last problem, so a stuck step is
 * visible on the card rather than only in the logs. Renders nothing for a
 * challenge without a scenario. `compact` is the one-line tile variant.
 *
 * @param {{status: ReturnType<typeof import('@/api/useScenarioStatus').useScenarioStatus>, compact?: boolean}} props
 */
export function ScenarioStatusLine({ status, compact = false }) {
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
            {status.lastError && (
                <div className={`text-warning ${compact ? 'line-clamp-2' : ''}`} role="status">
                    {interp(t('app.scenarioStatusProblem'), { message: status.lastError })}
                </div>
            )}
        </div>
    );
}
