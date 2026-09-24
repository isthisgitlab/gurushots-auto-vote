import { useTranslation } from '@/contexts/TranslationContext';
import { useListDraft, LIST_FINGERPRINT_SEP } from '@/hooks/useListDraft';
import { secondsToHoursMinutes, hoursMinutesToSeconds } from '@/utils/timeFieldUnits';
import { MAX_SCHEDULED_FILL_ENTRIES } from '../../../settings/limits';
import { SettingResetButton } from './SettingResetButton';

// Single source of truth: settings/limits.js is dependency-free, so importing
// it here costs the renderer bundle nothing (unlike settings/schema.js, which
// requires zod). Re-exported under the local name its consumers already use.
export const SCHEDULED_FILL_MAX_ENTRIES = MAX_SCHEDULED_FILL_ENTRIES;

// The schedule covers images 2–4: entry 1 always exists (joining a challenge
// IS submitting a photo) and GuruShots challenges allow at most 4 images.
// The seconds cap mirrors MAX_SCHEDULE_SECONDS in settings/schema.js.
const SCHEDULE_COUNTS = [2, 3, 4];
const SCHEDULE_MAX_SECONDS = 30 * 24 * 3600;
const SCHEDULE_MAX_HOURS = SCHEDULE_MAX_SECONDS / 3600;

/**
 * Full bounds check for a stored seconds value, not just the cap: a
 * hand-corrupted negative or fractional value renders as 0h 0m
 * (secondsToHoursMinutes clamps) yet isn't 0, so without this it would look
 * like an off/draft row instead of being flagged invalid — and the zod
 * validator would reject the save with only the generic banner.
 */
const secondsOutOfRange = (seconds) =>
    seconds !== 0 && (!Number.isInteger(seconds) || seconds < 0 || seconds > SCHEDULE_MAX_SECONDS);

/**
 * An hours + minutes number pair editing one duration stored as seconds.
 * `onChange(seconds)` receives the recombined value; `labelPrefix` names both
 * inputs ("<prefix> hours" / "<prefix> minutes"). Rendered as a fragment so
 * the caller's flex row owns the layout.
 */
function HoursMinutesInputs({ seconds, onChange, labelPrefix, widthClass, hoursMax, invalid, describedBy, disabled }) {
    const { t } = useTranslation();
    const { hours, minutes } = secondsToHoursMinutes(seconds);
    const className = `input input-bordered input-sm ${widthClass}${invalid ? ' input-error' : ''}`;
    return (
        <>
            <input
                type="number"
                className={className}
                min="0"
                max={hoursMax}
                aria-label={`${labelPrefix} ${t('app.hours')}`}
                aria-describedby={describedBy}
                value={hours}
                onChange={(e) => onChange(hoursMinutesToSeconds(parseInt(e.target.value, 10), minutes))}
                disabled={disabled}
            />
            <span className="text-sm">{t('app.hours')}</span>
            <input
                type="number"
                className={className}
                min="0"
                max="59"
                aria-label={`${labelPrefix} ${t('app.minutes')}`}
                aria-describedby={describedBy}
                value={minutes}
                onChange={(e) => onChange(hoursMinutesToSeconds(hours, parseInt(e.target.value, 10)))}
                disabled={disabled}
            />
            <span className="text-sm">{t('app.minutes')}</span>
        </>
    );
}

/** Single duration setting (`type: 'time'`): hours + minutes, stored as seconds. */
export function TimeField({ id, settingKey, config, value, onChange, onReset, disabled }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-2" role="group" aria-labelledby={`${id}-label`}>
            <HoursMinutesInputs
                seconds={value}
                onChange={(seconds) => onChange(settingKey, seconds)}
                labelPrefix={t(config.label)}
                widthClass="w-20"
                disabled={disabled}
            />
            <SettingResetButton settingKey={settingKey} onReset={onReset} />
        </div>
    );
}

const scheduleSecondsFor = (rows, count) => {
    const row = rows.find((r) => r && typeof r === 'object' && r.count === count);
    return Number.isFinite(row?.seconds) ? row.seconds : 0;
};

/**
 * A row is dead when another ACTIVE row reaches at least the same count no
 * later (larger-or-equal threshold): the max-based trigger never needs it.
 * Off rows are excluded entirely — they show only the off hint, never a
 * dominated badge on top (a deliberate off state is not a mistake).
 */
const isDominated = (activeRows, count, seconds) =>
    activeRows.some(
        (other) => other.count >= count && other.seconds >= seconds && (other.count > count || other.seconds > seconds),
    );

/**
 * Auto-fill schedule editor: three FIXED rows — Image 2, Image 3, Image 4 —
 * each just a time-before-close ("have ≥ N entries once ≤ this much time
 * remains"). 0h 0m = off: that image gets no scheduled trigger of its own,
 * though it may still be filled while catching up to a later step (the
 * trigger is max-based). Emits only rows with seconds > 0, ordered by count,
 * so "all off" emits [] — the runtime's 'no-schedule' state. Rebuilding from
 * the three fixed slots is lossy by design: any stored row not keyed by
 * counts 2/3/4 is dropped on the first edit (the load-time sanitizer in
 * settings/migrations.js removes such rows anyway).
 */
export function ScheduleField({ settingKey, value, onChange, onReset, disabled }) {
    const { t } = useTranslation();
    const rows = Array.isArray(value) ? value : [];
    const slots = SCHEDULE_COUNTS.map((count) => ({ count, seconds: scheduleSecondsFor(rows, count) }));
    const activeRows = slots.filter((row) => row.seconds > 0);

    const emit = (count, seconds) => {
        const next = slots.map((slot) => (slot.count === count ? { count, seconds } : slot));
        onChange(
            settingKey,
            next.filter((row) => row.seconds > 0),
        );
    };

    return (
        <div className="space-y-2">
            {slots.map(({ count, seconds }) => {
                const off = seconds === 0;
                const outOfRange = secondsOutOfRange(seconds);
                const dominated = !off && !outOfRange && isDominated(activeRows, count, seconds);
                const hintId = `${settingKey}-row-${count}-hint`;
                const rowLabel = `${t('app.autoFillScheduleImage')} ${count}`;
                return (
                    <div key={count} className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm w-20">{rowLabel} ≤</span>
                        <HoursMinutesInputs
                            seconds={seconds}
                            onChange={(next) => emit(count, next)}
                            labelPrefix={rowLabel}
                            widthClass="w-16"
                            hoursMax={SCHEDULE_MAX_HOURS}
                            invalid={outOfRange}
                            describedBy={hintId}
                            disabled={disabled}
                        />
                        <span aria-live="polite" id={hintId} className="text-xs">
                            {off && <span className="opacity-60">{t('app.autoFillScheduleOff')}</span>}
                            {outOfRange && <span className="text-error">{t('app.autoFillScheduleOutOfRange')}</span>}
                            {dominated && (
                                <span className="badge badge-warning badge-xs">
                                    {t('app.autoFillScheduleDominated')}
                                </span>
                            )}
                        </span>
                    </div>
                );
            })}
            {activeRows.length === 0 && (
                <div role="status" className="text-xs text-warning">
                    {t('app.autoFillScheduleEmpty')}
                </div>
            )}
            {onReset && (
                <div className="flex items-center gap-2">
                    <SettingResetButton settingKey={settingKey} onReset={onReset} />
                </div>
            )}
        </div>
    );
}

// What a time-list draft emits: rows in order, dropping drafts (`isDraft`) and
// duplicates (first wins).
const emittedRowsOf = (rowList, isDraft) => {
    const seen = new Set();
    return rowList.filter((row) => {
        if (isDraft(row) || seen.has(row)) return false;
        seen.add(row);
        return true;
    });
};
// A blank time input is a draft; a 0-second (or non-positive) offset is too.
const emittedTimesOf = (rowList) => emittedRowsOf(rowList, (row) => row === '');
const emittedSecondsOf = (rowList) => emittedRowsOf(rowList, (row) => !(row > 0));
const copyRows = (arr) => arr.slice();

/**
 * A row list's footer: the add button (disabled at the entry cap), the empty
 * and at-cap status messages, and the setting's reset.
 */
function RowListFooter({ kind, settingKey, rowCount, onAdd, onReset, disabled }) {
    const { t } = useTranslation();
    const atCap = rowCount >= SCHEDULED_FILL_MAX_ENTRIES;
    return (
        <div className="flex items-center gap-2 flex-wrap">
            <button className="btn btn-outline btn-sm" onClick={onAdd} disabled={disabled || atCap}>
                {t(kind.addLabelKey)}
            </button>
            {rowCount === 0 && (
                <span role="status" className="text-sm opacity-70">
                    {t(kind.emptyLabelKey)}
                </span>
            )}
            {atCap && (
                <span role="status" className="text-xs text-warning">
                    {t('app.scheduledFillMaxEntries').replace('{0}', String(SCHEDULED_FILL_MAX_ENTRIES))}
                </span>
            )}
            <SettingResetButton settingKey={settingKey} onReset={onReset} />
        </div>
    );
}

/**
 * Shared shell of the variable add/remove row-list editors: draft sync
 * (useListDraft's fingerprint pattern, keyed on what the draft EMITS),
 * first-wins dedupe on emission, the entry cap, per-row hint regions and the
 * add / empty / at-cap footer. Row-list structure follows TitleTagRulesEditor
 * (the codebase's add/remove-row precedent).
 *
 * `kind` supplies the row type: `emittedOf(rows)` (what the list emits),
 * `draftKeyOf(rows)` (its fingerprint), `blankRow` (what "add" appends),
 * `addLabelKey` / `emptyLabelKey`, and `renderRow(ctx)` returning the row's
 * `{ controls, hint }`. Row inputs are labelled "<setting label> <n>".
 *
 * A11y: per-row hint ids (ScheduleField-style — one shared region could only
 * expose one row's text), indexed aria-labels on the inputs AND the remove
 * buttons, and a persistent role="status" message at the entry cap (a
 * disabled add button is skipped by Tab, so its reason must be perceivable
 * without hover).
 */
function RowListField({ kind, settingKey, config, value, onChange, onReset, disabled }) {
    const { t } = useTranslation();
    const label = t(config.label);
    // The cap slice also bounds rendering: a hand-edited oversized array must
    // not paint hundreds of rows (the write path and load-time bounds pass
    // both enforce the cap already — this is the same defensive posture as
    // the decision/cadence consumers).
    const arr = (Array.isArray(value) ? value : []).slice(0, SCHEDULED_FILL_MAX_ENTRIES);
    const [rows, setRows] = useListDraft(arr, copyRows, kind.draftKeyOf);

    const update = (nextRows) => {
        setRows(nextRows);
        onChange(settingKey, kind.emittedOf(nextRows));
    };

    return (
        <div className="space-y-2">
            {rows.map((row, index) => {
                const hintId = `${settingKey}-row-${index}-hint`;
                const setRow = (next) => update(rows.map((r, j) => (j === index ? next : r)));
                const { controls, hint } = kind.renderRow({ row, index, rows, label, hintId, setRow, disabled, t });
                return (
                    <div key={index} className="flex items-center gap-2 flex-wrap">
                        {controls}
                        <button
                            className="btn btn-ghost btn-sm"
                            aria-label={`${t('app.scheduledFillRemoveEntry')} ${index + 1}`}
                            onClick={() => update(rows.filter((_, j) => j !== index))}
                            disabled={disabled}
                        >
                            ✕
                        </button>
                        <span aria-live="polite" id={hintId} className="text-xs">
                            {hint}
                        </span>
                    </div>
                );
            })}
            <RowListFooter
                kind={kind}
                settingKey={settingKey}
                rowCount={rows.length}
                onAdd={() => update([...rows, kind.blankRow])}
                onReset={onReset}
                disabled={disabled}
            />
        </div>
    );
}

/**
 * Scheduled-fill daily times (`type: 'timeOfDayList'`): one native
 * <input type="time"> per row. Emission drops empty rows (a just-added row
 * stays a local draft, never emitting an invalid '' entry); a duplicate row
 * is flagged inline. No draft hint, unlike the before-end list: a blank
 * native time input visibly reads as empty, while a 0h 0m pair there looks
 * like a filled, valid value.
 */
const TIME_OF_DAY_ROWS = {
    emittedOf: emittedTimesOf,
    draftKeyOf: (rows) => emittedTimesOf(rows).join(LIST_FINGERPRINT_SEP),
    blankRow: '',
    addLabelKey: 'app.scheduledFillAddTime',
    emptyLabelKey: 'app.scheduledFillTimeOff',
    renderRow: ({ row, index, rows, label, hintId, setRow, disabled, t }) => {
        const duplicate = row !== '' && rows.indexOf(row) !== index;
        return {
            controls: (
                <input
                    type="time"
                    className={`input input-bordered input-sm w-32 ${duplicate ? 'input-error' : ''}`}
                    aria-label={`${label} ${index + 1}`}
                    aria-describedby={hintId}
                    value={row}
                    onChange={(e) => setRow(e.target.value)}
                    disabled={disabled}
                />
            ),
            hint: duplicate && <span className="text-error">{t('app.scheduledFillDuplicateEntry')}</span>,
        };
    },
};

/**
 * Scheduled-fill before-end offsets (`type: 'timeList'`): one hours+minutes
 * pair per row, each stored as seconds. 0-second rows stay local drafts
 * (ScheduleField's emit-only-active precedent); duplicates and out-of-range
 * values highlight the offending row.
 */
const BEFORE_END_ROWS = {
    emittedOf: emittedSecondsOf,
    draftKeyOf: (rows) => emittedSecondsOf(rows).join(LIST_FINGERPRINT_SEP),
    blankRow: 0,
    addLabelKey: 'app.scheduledFillAddBeforeEnd',
    emptyLabelKey: 'app.scheduledFillBeforeEndOff',
    renderRow: ({ row, index, rows, label, hintId, setRow, disabled, t }) => {
        const seconds = Number.isFinite(row) ? row : 0;
        const duplicate = seconds > 0 && rows.indexOf(row) !== index;
        const outOfRange = secondsOutOfRange(seconds);
        return {
            controls: (
                <HoursMinutesInputs
                    seconds={seconds}
                    onChange={setRow}
                    labelPrefix={`${label} ${index + 1}`}
                    widthClass="w-16"
                    hoursMax={SCHEDULE_MAX_HOURS}
                    invalid={duplicate || outOfRange}
                    describedBy={hintId}
                    disabled={disabled}
                />
            ),
            hint: (
                <>
                    {seconds === 0 && <span className="opacity-60">{t('app.scheduledFillEntryDraft')}</span>}
                    {outOfRange && <span className="text-error">{t('app.autoFillScheduleOutOfRange')}</span>}
                    {duplicate && <span className="text-error">{t('app.scheduledFillDuplicateEntry')}</span>}
                </>
            ),
        };
    },
};

export function TimeOfDayListField(props) {
    return <RowListField kind={TIME_OF_DAY_ROWS} {...props} />;
}

export function TimeListField(props) {
    return <RowListField kind={BEFORE_END_ROWS} {...props} />;
}
