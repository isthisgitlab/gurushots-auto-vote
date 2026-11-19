import { useCallback, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { ToneNote } from '@/components/ui/ToneNote';
import { EffectOutcomeNotice } from '@/components/ui/EffectOutcomeNotice';
import { ScenarioStatusLine } from './ScenarioStatusLine';
import { ScenarioResetModal } from './ScenarioResetModal';
import { ipcErrorText } from '@/api/ipcErrorText';
import { scenarioRefusalText, statusReasonText } from '@/utils/scenarioIssueText';
import { refreshScenarioStatuses, usePendingRequest, useScenarioSnapshot } from '@/api/useScenarioStatus';
import { useAsyncIpcAction } from '@/api/useAsyncIpcAction';
import { checkEffectStatus, resumeScenario } from '@/api/ipc';

import type { Challenge } from '../../../core/types/gurushots';
import type { ScenarioSnapshotView } from '@/api/useScenarioStatus';
import type * as useScenarioStatusModule from '@/api/useScenarioStatus';
import type { Translate } from '../../../core/translations/translator';
import type { ResolvedSchedules, ResolvedSubmitRow, ResolvedWindowRow } from '../../../core/types/autoFill';
import type { ValueState } from '../../../core/scenarios/valueState';
import type { EffectOutcome } from '@/api/ipc';

/**
 * A card's scenario status with the way to reset its progress: the status line, the dialog its Reset button
 * opens, and — while a scenario runs — the "what applies now" detail: the effective value and source of every
 * overlaid setting, the resolved schedule rows with their next deadline, the pause with its Resume, and a
 * lifecycle request that is still waiting for its answer. What the dialog resets is fixed when it opens (every
 * challenge's progress when the saved progress cannot be read, else this challenge's), and every card reads its
 * status again afterwards.
 */
export function ScenarioStatusPanel({
    status,
    challenge,
}: {
    status: ReturnType<typeof useScenarioStatusModule.useScenarioStatus>;
    challenge: Pick<Challenge, 'id' | 'title' | 'url'>;
}) {
    const [resetting, setResetting] = useState<'one' | 'all' | null>(null);
    const hasPlan = Boolean(status && !status.missing && !status.corrupt);
    return (
        <>
            <ScenarioStatusLine
                status={status}
                onReset={() => setResetting(status?.corrupt === 'file' ? 'all' : 'one')}
            />
            {hasPlan && <SnapshotDetail subject={String(challenge.id)} />}
            <ScenarioResetModal
                challenge={resetting ? challenge : null}
                everyChallenge={resetting === 'all'}
                onClose={() => setResetting(null)}
                onChanged={refreshScenarioStatuses}
            />
        </>
    );
}

/** One overlaid setting's value in plain words: the value, "Not applicable", or "Missing data" and why. */
const valueStateText = (state: ValueState<unknown>, t: Translate): string => {
    if (state.state === 'known') return String(state.value);
    if (state.state === 'absent') return t('app.scenarioValueAbsent');
    return t('app.scenarioValueUnknown', { reason: statusReasonText(state.reason, t) });
};

/** One resolved schedule in words: every row's count and the instant it is due by, or why it is not known. */
const scheduleRows = (schedules: ResolvedSchedules, t: Translate): string[] => {
    // A row confirmed absent is not applicable (nothing is missing); only an unknown one is missing data.
    const unusable = (row: { state: 'absent' | 'unknown'; reason: string }): string =>
        row.state === 'absent'
            ? t('app.scenarioValueAbsent')
            : t('app.scenarioValueUnknown', { reason: statusReasonText(row.reason, t) });
    const when = (row: ResolvedSubmitRow): string =>
        row.state === 'known' ? new Date(row.at * 1000).toLocaleString() : unusable(row);
    const windows = (rows: ResolvedWindowRow[]): string[] =>
        rows.map((row) =>
            row.state === 'known'
                ? t('app.scenarioDeadlineRow', {
                      from: new Date(row.start * 1000).toLocaleString(),
                      to: new Date(row.end * 1000).toLocaleString(),
                  })
                : unusable(row),
        );
    return [
        ...(schedules.submit?.rows.map((row) => t('app.sbDeadline_submit', { count: row.count, at: when(row) })) ?? []),
        ...(schedules.vote ? windows(schedules.vote.rows) : []),
        ...(schedules.pause ? windows(schedules.pause.rows) : []),
    ];
};

/** Which source of a phase overlay a key's value came from. */
const SOURCE_KEYS = {
    patch: 'app.scenarioSourcePatch',
    literals: 'app.scenarioSourcePhase',
    bindings: 'app.scenarioSourcePhase',
    profile: 'app.scenarioSourceProfile',
} as const;

/**
 * The "what applies now" of one running scenario: its overlay's keys with their effective values and sources, its
 * resolved schedule rows, the pause with its Resume, and a lifecycle request that is still open.
 */
function SnapshotDetail({ subject }: { subject: string }) {
    const { t } = useTranslation();
    const snapshot = useScenarioSnapshot(subject);
    const pending = usePendingRequest(subject);
    const resume = useAsyncIpcAction(
        useCallback(() => resumeScenario(subject), [subject]),
        {
            failureMessage: 'busy',
        },
    );
    // A pending request the target read found, as the shared notice reads an outcome (it checks by identity). The
    // host owns it, so giving it up only hides it here.
    const [dismissed, setDismissed] = useState(false);
    const outcome: EffectOutcome | null =
        pending !== null && !dismissed ? { kind: 'waiting', requestId: pending.requestId, checked: null } : null;

    if (snapshot === null) {
        // The summary stays while the read is on its way (or failed): the card keeps its line either way.
        return (
            <details className="text-xs text-base-content/80">
                <summary className="cursor-pointer">{t('app.scenarioWhatApplies')}</summary>
                <p className="mt-1">{t('common.loading')}</p>
            </details>
        );
    }
    return (
        <details className="text-xs text-base-content/80">
            <summary className="cursor-pointer">{t('app.scenarioWhatApplies')}</summary>
            <div className="space-y-2 mt-1">
                {snapshot.overlay === null ? null : snapshot.overlay.available ? (
                    <OverlayRows overlay={snapshot.overlay} snapshot={snapshot} />
                ) : (
                    <ToneNote tone="warning" role="status">
                        {t('app.scenarioOverlayUnavailable', { reason: statusReasonText(snapshot.overlay.reason, t) })}
                    </ToneNote>
                )}
                <ScheduleRowsView snapshot={snapshot} />
                {snapshot.pool?.block != null && (
                    <ToneNote tone="warning" role="status">
                        {t(
                            snapshot.pool.block === 'pool-unbound'
                                ? 'app.scenarioPoolBlock_unbound'
                                : 'app.scenarioPoolBlock_exhausted',
                        )}
                    </ToneNote>
                )}
                {snapshot.paused !== null && (
                    <div className="flex flex-wrap items-center gap-2">
                        <span>{t('app.scenarioPaused')}</span>
                        <button
                            type="button"
                            className="btn btn-sm max-sm:min-h-10"
                            disabled={resume.loading}
                            onClick={() => void resume.run()}
                        >
                            {t('app.scenarioResume')}
                        </button>
                        {resume.error !== null && (
                            <span>
                                {scenarioRefusalText(resume.error, t) ??
                                    ipcErrorText(resume.error, t, 'errors.actionFailed')}
                            </span>
                        )}
                        <EffectOutcomeNotice
                            outcome={resume.outcome}
                            onCheck={resume.checkStatus}
                            onDismiss={resume.dismissOutcome}
                        />
                    </div>
                )}
                {outcome !== null && (
                    <EffectOutcomeNotice
                        outcome={outcome}
                        onCheck={async () => (await checkEffectStatus(outcome)).settled}
                        onDismiss={() => setDismissed(true)}
                    />
                )}
            </div>
        </details>
    );
}

/** The overlaid keys with their effective values, one row each, in the source order of the overlay. */
function OverlayRows({
    overlay,
    snapshot,
}: {
    overlay: NonNullable<ScenarioSnapshotView['overlay']>;
    snapshot: ScenarioSnapshotView;
}) {
    const { t } = useTranslation();
    const sources = overlay.sources;
    // Every key the overlay reaches, with the first source that holds it.
    const entries = (Object.keys(SOURCE_KEYS) as Array<keyof typeof SOURCE_KEYS>).flatMap((source) =>
        sources[source].map((key) => ({ key, source })),
    );
    if (entries.length === 0) return null;
    const seen = new Set<string>();
    const rows = entries.filter(({ key }) => (seen.has(key) ? false : seen.add(key) !== undefined));
    const label = (key: string): string => {
        const translated = t(`app.${key}`);
        return translated === `app.${key}` ? key : translated;
    };
    return (
        <ul className="space-y-0.5">
            {rows.map((entry) => {
                // One text run per row: the key, its value and its source read together (also as one label).
                const state = snapshot.effective[entry.key];
                return (
                    <li key={entry.key}>
                        {`${label(entry.key)}: ${state ? valueStateText(state, t) : ''} (${t(SOURCE_KEYS[entry.source])})`}
                    </li>
                );
            })}
        </ul>
    );
}

/** The resolved schedule rows of the snapshot's phase, with their next deadline, or why none can be read. */
function ScheduleRowsView({ snapshot }: { snapshot: ScenarioSnapshotView }) {
    const { t } = useTranslation();
    const read = snapshot.schedules;
    if (read === null || read.kind === 'none') return null;
    if (read.kind === 'unavailable') {
        return (
            <ToneNote tone="warning" role="status">
                {t('app.scenarioScheduleUnknown', { reason: statusReasonText(read.reason, t) })}
            </ToneNote>
        );
    }
    const rows = scheduleRows(read.schedules, t);
    if (rows.length === 0) return null;
    return (
        <div className="space-y-0.5">
            <div className="font-medium">{t('app.sbDeadlines')}</div>
            <ul className="list-disc ml-4">
                {rows.map((row, index) => (
                    <li key={index}>{row}</li>
                ))}
            </ul>
        </div>
    );
}
