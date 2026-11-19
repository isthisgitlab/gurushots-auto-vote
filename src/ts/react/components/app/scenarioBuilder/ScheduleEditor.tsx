import { useTranslation } from '@/contexts/TranslationContext';
import { MAX_SCHEDULED_FILL_ENTRIES } from '../../../../core/settings/limits';
import { defaultExpression, SCHEDULE_REPLACED_KEYS, SUBMIT_MAX_ROWS } from '../../../../core/scenarios/builderSpec';
import { ExpressionEditor } from './ExpressionEditor';

import type { ExpressionContext } from './ExpressionEditor';
import type { ComponentChildren } from 'preact';

/**
 * The editor for a phase's dynamic schedules: when each photo is due by (the
 * submit schedule, one row per cumulative count) and when voting runs and
 * pauses (window schedules of an instant and a length). Every instant and
 * duration is a live value the ExpressionEditor builds. A schedule replaces
 * the literal settings of its own name, so a phase that holds one of those is
 * not offered the schedule — the add button names the setting in the way.
 */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** One labelled cell of the editor's field grid. */
function Cell({ label, children }: { label: string; children: ComponentChildren }) {
    return (
        <div role="group" aria-label={label} className="flex flex-col text-xs gap-1">
            <span className="opacity-70" aria-hidden="true">
                {label}
            </span>
            {children}
        </div>
    );
}

/**
 * The three schedules a phase may carry, each added and removed as a whole.
 *
 * @param props.schedules - the phase's `schedules` object, or anything a hand edit left there
 * @param props.onChange - the next `schedules` object, or undefined when no schedule is left
 * @param props.heldKeys - the setting keys the phase already sets or binds (a schedule replaces its own)
 */
export function ScheduleEditor({
    schedules,
    onChange,
    context,
    heldKeys,
}: {
    schedules: unknown;
    onChange: (next: Record<string, unknown> | undefined) => void;
    context: ExpressionContext;
    heldKeys: readonly string[];
}) {
    const { t } = useTranslation();
    const doc = isPlainObject(schedules) ? schedules : {};
    const held = (name: 'submit' | 'vote' | 'pause') => (isPlainObject(doc[name]) ? doc[name] : null);
    const write = (name: 'submit' | 'vote' | 'pause', next: Record<string, unknown> | null) => {
        const merged = { ...doc, [name]: next };
        for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
        onChange(Object.keys(merged).length === 0 ? undefined : merged);
    };
    /** The setting a schedule kind replaces that the phase already holds, or null (the add button names it). */
    const conflictOf = (name: 'submit' | 'vote' | 'pause'): string | null =>
        SCHEDULE_REPLACED_KEYS[name].find((key) => heldKeys.includes(key)) ?? null;

    return (
        <div className="space-y-2">
            <div className="text-xs font-medium">{t('app.sbSchedules')}</div>
            <p className="text-xs text-base-content/70">{t('app.sbSchedulesHint')}</p>
            {(['submit', 'vote', 'pause'] as const).map((name) => {
                const conflict = conflictOf(name);
                return held(name) === null ? (
                    <div key={name} className="space-y-1">
                        <button
                            type="button"
                            className="btn btn-sm"
                            disabled={conflict !== null}
                            onClick={() =>
                                write(
                                    name,
                                    name === 'submit'
                                        ? {
                                              alignment: 'end',
                                              rows: [
                                                  {
                                                      count: 1,
                                                      at: defaultExpression('fact', 'instant', {
                                                          stages: context.stages,
                                                          baseOnly: context.baseOnly,
                                                      }),
                                                  },
                                              ],
                                          }
                                        : {
                                              rows: [
                                                  {
                                                      at: defaultExpression('fact', 'instant', {
                                                          stages: context.stages,
                                                          baseOnly: context.baseOnly,
                                                      }),
                                                      duration: defaultExpression('literal', 'duration', {}),
                                                  },
                                              ],
                                          },
                                )
                            }
                        >
                            {t(`app.sbScheduleAdd_${name}`)}
                        </button>
                        {conflict !== null && (
                            <p className="text-xs text-base-content/70">
                                {t('app.actionOnItem', {
                                    action: t('app.sbScheduleReplaces'),
                                    item: t(`app.${conflict}`),
                                })}
                            </p>
                        )}
                    </div>
                ) : (
                    <ScheduleKind
                        key={name}
                        name={name}
                        value={held(name) as Record<string, unknown>}
                        onChange={(next) => write(name, next)}
                        context={context}
                    />
                );
            })}
        </div>
    );
}

/**
 * One schedule kind's rows.
 */
function ScheduleKind({
    name,
    value,
    onChange,
    context,
}: {
    name: 'submit' | 'vote' | 'pause';
    value: Record<string, unknown>;
    onChange: (next: Record<string, unknown> | null) => void;
    context: ExpressionContext;
}) {
    const { t } = useTranslation();
    const rows = Array.isArray(value.rows) ? value.rows : [];
    const row = (index: number) => (isPlainObject(rows[index]) ? rows[index] : {});
    const setRows = (next: unknown[]) => (next.length === 0 ? onChange(null) : onChange({ ...value, rows: next }));
    const patchRow = (index: number, patch: Record<string, unknown>) =>
        setRows(rows.map((old, i) => (i === index ? { ...row(index), ...patch } : old)));
    const maxRows = name === 'submit' ? SUBMIT_MAX_ROWS : MAX_SCHEDULED_FILL_ENTRIES;
    const submit = name === 'submit';
    const takenCounts = new Set(
        rows.flatMap((item) => (isPlainObject(item) && typeof item.count === 'number' ? [item.count] : [])),
    );
    /** The first count not taken; the add button is off once all four are, so one is always free. */
    const firstFreeCount = (): number =>
        Array.from({ length: SUBMIT_MAX_ROWS }, (_, n) => n + 1).find((count) => !takenCounts.has(count)) as number;
    return (
        <div className="rounded border border-base-300 p-2 space-y-2 bg-base-100">
            <div className="flex flex-wrap gap-2 items-center">
                <span className="text-xs font-medium">{t(`app.sbSchedule_${name}`)}</span>
                {submit && (
                    <select
                        className="select select-sm"
                        aria-label={t('app.sbField_alignment')}
                        value={typeof value.alignment === 'string' ? value.alignment : 'end'}
                        onChange={(e) => onChange({ ...value, alignment: e.currentTarget.value })}
                    >
                        <option value="end">{t('app.sbOpt_alignment_end')}</option>
                        <option value="absolute">{t('app.sbOpt_alignment_absolute')}</option>
                    </select>
                )}
                <button
                    type="button"
                    className="btn btn-sm btn-ghost text-error"
                    aria-label={t('app.actionOnItem', {
                        action: t('app.sbRemove'),
                        item: t(`app.sbSchedule_${name}`),
                    })}
                    onClick={() => onChange(null)}
                >
                    {t('app.sbRemove')}
                </button>
            </div>
            {rows.map((_, index) => (
                <div key={index} className="flex flex-wrap gap-2 items-start">
                    {submit && (
                        <Cell label={t('app.sbScheduleCount')}>
                            <select
                                className="select select-sm"
                                aria-label={t('app.sbScheduleCount')}
                                value={typeof row(index).count === 'number' ? String(row(index).count) : ''}
                                onChange={(e) => patchRow(index, { count: Number(e.currentTarget.value) })}
                            >
                                {Array.from({ length: SUBMIT_MAX_ROWS }, (_, n) => n + 1)
                                    .filter((count) => !takenCounts.has(count) || count === row(index).count)
                                    .map((count) => (
                                        <option key={count} value={count}>
                                            {t('app.sbSchedulePhotoN', { n: count })}
                                        </option>
                                    ))}
                            </select>
                        </Cell>
                    )}
                    <Cell label={t('app.sbField_at')}>
                        <ExpressionEditor
                            value={row(index).at}
                            onChange={(next) => patchRow(index, { at: next })}
                            expected="instant"
                            context={context}
                        />
                    </Cell>
                    {!submit && (
                        <Cell label={t('app.sbField_duration')}>
                            <ExpressionEditor
                                value={row(index).duration}
                                onChange={(next) => patchRow(index, { duration: next })}
                                expected="duration"
                                context={context}
                            />
                        </Cell>
                    )}
                    <button
                        type="button"
                        className="btn btn-sm btn-ghost text-error"
                        aria-label={t('app.actionOnItem', {
                            action: t(`app.sbScheduleRemoveRow_${name}`),
                            item: `${index + 1}`,
                        })}
                        onClick={() => setRows(rows.filter((_, i) => i !== index))}
                    >
                        {t('app.sbRemove')}
                    </button>
                </div>
            ))}
            <button
                type="button"
                className="btn btn-sm"
                disabled={rows.length >= maxRows || (submit && takenCounts.size >= SUBMIT_MAX_ROWS)}
                onClick={() =>
                    setRows([
                        ...rows,
                        submit
                            ? {
                                  count: firstFreeCount(),
                                  at: defaultExpression('fact', 'instant', {
                                      stages: context.stages,
                                      baseOnly: context.baseOnly,
                                  }),
                              }
                            : {
                                  at: defaultExpression('fact', 'instant', {
                                      stages: context.stages,
                                      baseOnly: context.baseOnly,
                                  }),
                                  duration: defaultExpression('literal', 'duration', {}),
                              },
                    ])
                }
            >
                {t(`app.sbScheduleAddRow_${name}`)}
            </button>
        </div>
    );
}
