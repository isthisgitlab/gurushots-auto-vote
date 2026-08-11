import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSettingsSchema } from '@/api/useSettingsSchema';
import { groupSchemaEntries } from '@/utils/groupSettings';
import { getGroupApplicability } from '@/utils/challengeApplicability';
import { formatSettingDefault } from '@/utils/formatters';
import { formatSecondsAsHoursMinutes } from '@/utils/timeFieldUnits';
import { getScheduleShift } from '../../../services/scheduleRemap';
import { occurrencesOf } from '../../../scheduling/wallClock';
import { DEFAULT_TIMEZONE } from '../../../settings/uiDefaults';
import { SettingInput, SCHEDULED_FILL_MAX_ENTRIES } from './SettingInput';
import { ChallengeProfilesBar } from './ChallengeProfilesBar';
import { Modal } from '@/components/ui/Modal';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ModalActionRow } from '@/components/ui/ModalActionRow';
import { useAutovote } from '@/contexts/AutovoteContext';

/**
 * Per-challenge settings modal
 */
export function ChallengeSettingsModal({ isOpen, onClose, challengeId, challengeTitle, challenge = null }) {
    const { t } = useTranslation();
    const { rearmSchedule } = useAutovote();
    const {
        schema,
        defaults,
        groups,
        profileLimits,
        refetch: refetchSchema,
        loading: schemaLoading,
    } = useSettingsSchema();

    // Local state for override values
    const [overrides, setOverrides] = useState({});
    const [saving, setSaving] = useState(false);
    const [loading, setLoading] = useState(true);
    // True when a setChallengeOverride write was rejected by validation —
    // shown as an alert and the modal stays open so the edit isn't lost.
    const [saveError, setSaveError] = useState(false);
    // Top-level (non-schema) settings the scheduled-fill hints need: the app
    // timezone (the time input looks device-local but is interpreted in this
    // zone) and checkFrequencyMax (short-window warning). Fetched per open —
    // the schema-defaults map only covers SETTINGS_SCHEMA keys.
    const [appSettings, setAppSettings] = useState(null);
    // Set when a profile Apply flips scheduledFillReplaces on for a challenge
    // that didn't have it — that one field can silently cost a challenge its
    // fills, so it gets a highlighted warning the generic apply-hint lacks.
    const [profileReplacesWarning, setProfileReplacesWarning] = useState(false);

    // Refresh global defaults each time the modal opens so the
    // "Global default: …" hint reflects current persisted state.
    useEffect(() => {
        if (isOpen) {
            refetchSchema();
            setSaveError(false);
            setProfileReplacesWarning(false);
        }
    }, [isOpen, refetchSchema]);

    useEffect(() => {
        if (!isOpen) return undefined;
        let cancelled = false;
        (async () => {
            try {
                const loaded = await window.api.getSettings();
                if (!cancelled) setAppSettings(loaded || {});
            } catch {
                if (!cancelled) setAppSettings({});
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [isOpen]);

    // Load existing overrides once per (open, challengeId) session.
    //
    // Two intertwined concerns:
    //   1. Don't clobber in-progress user edits when useSettingsSchema
    //      refetches and hands us a new schema reference mid-session.
    //      Tracked by loadedForChallengeRef — once we've loaded for a
    //      given challengeId, the effect early-returns even if schema
    //      ref changes.
    //   2. Drop in-flight loads when the user closes the modal or the
    //      target challengeId changes before the IPC sequence resolves,
    //      so a stale setOverrides can never land. Tracked by the
    //      per-run `cancelled` flag set from the effect cleanup.
    //
    // The previous "single ref" guard handled (1) but missed (2), and
    // rapid open/close cycles could land stale state — which is the
    // most likely contributor to the blank page seen on rapid clicks.
    const loadedForChallengeRef = useRef(null);
    useEffect(() => {
        if (!isOpen) {
            loadedForChallengeRef.current = null;
            return undefined;
        }
        if (!challengeId || !schema) return undefined;
        if (loadedForChallengeRef.current === challengeId) return undefined;

        let cancelled = false;
        const load = async () => {
            setLoading(true);
            try {
                // Single batch IPC call (the facade's own-property-safe sparse
                // map) instead of one round-trip per schema key.
                const stored = await window.api.getChallengeOverrides(challengeId.toString());
                if (cancelled) return;
                const loaded = {};
                for (const [key, value] of Object.entries(stored || {})) {
                    if (schema[key]?.perChallenge) loaded[key] = value;
                }
                setOverrides(loaded);
                loadedForChallengeRef.current = challengeId;
            } catch (err) {
                if (cancelled) return;
                await window.api.logError(`Error loading challenge overrides: ${err.message || err}`);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        load();
        return () => {
            cancelled = true;
        };
    }, [isOpen, challengeId, schema]);

    const handleOverrideChange = useCallback((key, value) => {
        setOverrides((prev) => ({ ...prev, [key]: value }));
    }, []);

    const handleClearOverride = useCallback((key) => {
        setOverrides((prev) => {
            const newOverrides = { ...prev };
            delete newOverrides[key];
            return newOverrides;
        });
    }, []);

    const handleClearAll = useCallback(() => {
        setOverrides({});
    }, []);

    const handleSave = useCallback(async () => {
        // Schema can be null if its fetch failed but schemaLoading flipped
        // to false — the Save button is then reachable but Object.keys(null)
        // would throw. Bail out instead of crashing the boundary.
        if (!challengeId || !schema) return;

        setSaving(true);
        try {
            // Write the edited overrides FIRST. setChallengeOverride validates
            // and returns false on rejection (e.g. a duplicate-count auto-fill
            // schedule); bailing out here — before any removal below — means a
            // rejected edit leaves the key's previously valid override intact.
            // (The old clear-then-rewrite order silently dropped it: the clear
            // loop ran, the invalid rewrite never did, and closing the modal
            // lost the prior value with no trace.)
            let anyRejected = false;
            for (const [key, value] of Object.entries(overrides)) {
                const saved = await window.api.setChallengeOverride(key, challengeId.toString(), value);
                if (saved === false) anyRejected = true;
            }
            if (anyRejected) {
                setSaveError(true);
                return;
            }
            setSaveError(false);

            // Only after every write validated: drop the overrides the user
            // cleared this session (per-challenge keys absent from the local
            // overrides map).
            for (const key of Object.keys(schema)) {
                if (schema[key].perChallenge && !(key in overrides)) {
                    await window.api.removeChallengeOverride(key, challengeId.toString());
                }
            }

            // Re-arm the cadence timer so a changed per-challenge threshold /
            // scheduled fill takes effect now, not after the current wait.
            await rearmSchedule();

            onClose();
        } catch (err) {
            await window.api.logError(`Error saving challenge settings: ${err.message || err}`);
        } finally {
            setSaving(false);
        }
    }, [challengeId, overrides, schema, rearmSchedule, onClose]);

    if (!isOpen) return null;

    const title = `${t('app.challengeSettings')}: ${challengeTitle}`;

    // Scheduled-fill hint state, derived fresh per render from the effective
    // (override-or-global) values — same render-time spirit as the
    // scheduleShift hint below. Both triggers are LISTS; every entry opens
    // its own window. A failing wall-clock computation must never break the
    // modal, so the Intl math is guarded.
    const effectiveOf = (key) => (key in overrides ? overrides[key] : (defaults?.[key] ?? schema?.[key]?.default));
    const appTimezone = appSettings?.timezone || DEFAULT_TIMEZONE;
    const checkFrequencyMax = Number(appSettings?.checkFrequencyMax) || 0;
    const rawSfTimes = effectiveOf('scheduledFillTime');
    const sfTimes = (Array.isArray(rawSfTimes) ? rawSfTimes : []).slice(0, SCHEDULED_FILL_MAX_ENTRIES);
    const rawSfBeforeEnds = effectiveOf('scheduledFillBeforeEnd');
    const sfBeforeEnds = (Array.isArray(rawSfBeforeEnds) ? rawSfBeforeEnds : [])
        .slice(0, SCHEDULED_FILL_MAX_ENTRIES)
        .map(Number)
        .filter((sec) => sec > 0);
    const sfWindowMin = Number(effectiveOf('scheduledFillWindowMinutes')) || 60;
    const sfWindowSec = sfWindowMin * 60;
    const sfEnabled = effectiveOf('useScheduledFill') === true;
    const sfReplaces = effectiveOf('scheduledFillReplaces') === true;
    const nowSec = Math.floor(Date.now() / 1000);
    const closeTime = Number(challenge?.close_time) || 0;
    // Explicit arrow (never `map(occurrencesOf)`): map's (element, index,
    // array) signature would bind the index to the timeZone parameter. Each
    // occurrence stays PAIRED with its source entry before the invalid ones
    // are filtered out — a filter-then-reindex against sfTimes would mislabel
    // every hint source after the first unparseable entry.
    const sfTimeOccs = (() => {
        try {
            return sfTimes
                .map((entry) => ({ entry, occ: occurrencesOf(entry, appTimezone, nowSec) }))
                .filter((pair) => pair.occ);
        } catch {
            return [];
        }
    })();
    const sfTimeSet = sfTimeOccs.length > 0;
    const sfActive = sfEnabled && (sfTimeSet || sfBeforeEnds.length > 0);
    const formatInTz = (epochSec) => {
        try {
            return new Intl.DateTimeFormat(undefined, {
                timeZone: appTimezone,
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23',
            }).format(epochSec * 1000);
        } catch {
            return new Date(epochSec * 1000).toISOString().slice(11, 16);
        }
    };
    // Next-window candidates from BOTH lists: per time entry the open-or-next
    // occurrence, per before-end entry its one-shot start while the window is
    // still at least partly ahead. Each carries its producing trigger so the
    // hint can name whose window is shown.
    const sfCandidates = [];
    for (const { entry, occ } of sfTimeOccs) {
        const start = nowSec - occ.prev <= sfWindowSec ? occ.prev : occ.next;
        sfCandidates.push({ start, source: entry });
    }
    for (const sec of sfBeforeEnds) {
        if (closeTime <= nowSec) continue;
        const start = closeTime - sec;
        if (nowSec <= start + sfWindowSec) {
            sfCandidates.push({
                start,
                source: t('app.scheduledFillSourceBeforeEnd').replace(
                    '{0}',
                    formatSecondsAsHoursMinutes(sec, t('app.hours'), t('app.minutes')),
                ),
            });
        }
    }
    const sfNext = sfCandidates.reduce((best, c) => (best === null || c.start < best.start ? c : best), null);
    // With replace mode on, is any fill window still reachable for THIS
    // challenge? Unreachable means replace mode keeps blocking threshold
    // voting with no fill ever coming (e.g. a "5h before end" profile applied
    // to a challenge with 2h left).
    let sfUnreachable = false;
    if (sfActive && sfReplaces && closeTime > nowSec) {
        const beforeEndReachable = sfBeforeEnds.some((sec) => nowSec <= closeTime - sec + sfWindowSec);
        const timeOfDayReachable = sfTimeOccs.some(
            ({ occ }) => nowSec - occ.prev <= sfWindowSec || occ.next < closeTime,
        );
        sfUnreachable = !beforeEndReachable && !timeOfDayReachable;
    }
    /** Conditional inline hints for the scheduled-fill keys; [] for other keys. */
    const scheduledFillHints = (key) => {
        const hints = [];
        if (key === 'useScheduledFill') {
            if (sfEnabled && !sfTimeSet && sfBeforeEnds.length === 0) {
                hints.push({ tone: 'text-warning', text: t('app.scheduledFillNoTimesHint') });
            }
            // The next-window hint lives on the master-toggle row (feature-level
            // status): a before-end-only config — the issue's own motivating
            // case — would never see it on the daily-times row. It gates on
            // sfEnabled like every value-derived hint: a time typed in while
            // the toggle is off must not render an "active schedule" status.
            if (sfEnabled && sfNext) {
                hints.push({
                    tone: 'text-info',
                    text: t('app.scheduledFillNextHint')
                        .replace('{0}', formatInTz(sfNext.start))
                        .replace('{1}', formatInTz(sfNext.start + sfWindowSec))
                        .replace('{2}', appTimezone)
                        .replace('{3}', sfNext.source),
                });
            }
        }
        if (key === 'scheduledFillBeforeEnd' && sfEnabled) {
            const wasted = sfBeforeEnds.filter((sec) => sec < sfWindowSec);
            if (wasted.length > 0) {
                hints.push({
                    tone: 'text-warning',
                    text: t('app.scheduledFillWastedWindowHint').replace(
                        '{0}',
                        wasted
                            .map((sec) => formatSecondsAsHoursMinutes(sec, t('app.hours'), t('app.minutes')))
                            .join(', '),
                    ),
                });
            }
        }
        if (
            key === 'scheduledFillWindowMinutes' &&
            sfActive &&
            checkFrequencyMax > 0 &&
            sfWindowMin < checkFrequencyMax
        ) {
            hints.push({
                tone: 'text-warning',
                text: t('app.scheduledFillShortWindowHint').replace('{0}', String(checkFrequencyMax)),
            });
        }
        if (key === 'scheduledFillReplaces') {
            if (profileReplacesWarning) {
                hints.push({ tone: 'text-warning font-medium', text: t('app.scheduledFillProfileReplacesWarning') });
            }
            if (sfUnreachable) {
                hints.push({ tone: 'text-warning', text: t('app.scheduledFillUnreachableHint') });
            }
        }
        return hints;
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={title}>
            {schemaLoading || loading ? (
                <LoadingSpinner text={t('common.loading')} />
            ) : (
                <div className="space-y-4">
                    {saveError && (
                        <div className="alert alert-error py-2 text-sm" role="alert">
                            <span>{t('app.settingsSaveError')}</span>
                        </div>
                    )}
                    {/* Info about overrides */}
                    <div className="alert alert-info text-sm">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                            />
                        </svg>
                        <span>{t('app.challengeOverrideInfo')}</span>
                    </div>

                    {/* Named profiles: apply loads a saved tactic into the form
                        state below (schema-filtered, belt-and-braces on top of
                        the facade's whitelist); the Save button persists it. */}
                    <ChallengeProfilesBar
                        overrides={overrides}
                        profileLimits={profileLimits}
                        onApply={(values) => {
                            const next = {};
                            for (const [key, value] of Object.entries(values || {})) {
                                if (schema[key]?.perChallenge) next[key] = value;
                            }
                            const replacesWasOn =
                                ('scheduledFillReplaces' in overrides
                                    ? overrides.scheduledFillReplaces
                                    : defaults?.scheduledFillReplaces) === true;
                            setProfileReplacesWarning(next.scheduledFillReplaces === true && !replacesWasOn);
                            setOverrides(next);
                        }}
                    />

                    {/* Settings grouped into static sections. Groups whose
                        action can no longer apply to this challenge (boost/turbo
                        already used, all entry slots full) are greyed out and
                        their inputs disabled — a live, render-time hint derived
                        from the challenge prop, never persisted. */}
                    {groupSchemaEntries(schema, groups, { perChallengeOnly: true }).map(({ id, label, entries }) => {
                        const { applicable, reasonKey } = getGroupApplicability(id, challenge);
                        // When a group can't apply, tie its heading + reason note to
                        // the section via role="group"/aria-* so assistive tech
                        // announces *why* the inputs are disabled, not just that
                        // they are (WCAG 1.3.1 — the relationship must be
                        // programmatic, not only visual).
                        const headingId = `challenge-group-${id}`;
                        const reasonId = applicable ? undefined : `challenge-group-reason-${id}`;

                        return (
                            <div
                                key={id}
                                role={applicable ? undefined : 'group'}
                                aria-labelledby={applicable ? undefined : headingId}
                                aria-describedby={reasonId}
                            >
                                <h4
                                    id={headingId}
                                    className="font-semibold text-base mb-3 border-b border-base-300 pb-2 flex items-center justify-between gap-2"
                                >
                                    <span>{t(label)}</span>
                                    {!applicable && (
                                        <span className="badge badge-ghost badge-xs">{t('app.notApplicable')}</span>
                                    )}
                                </h4>
                                {/* Heading, badge and reason note stay at full opacity so the
                                    *why* remains readable; only the inert inputs below are dimmed.
                                    Dimming the whole group would compound with the muted text
                                    colours and push the explanation below WCAG AA contrast. */}
                                {!applicable && (
                                    <div id={reasonId} className="mb-3">
                                        <p className="text-xs text-base-content/80">{t(reasonKey)}</p>
                                        {/* Reassure that a stored override on this (now-inert) group is
                                            not lost — the "Overridden" badge below still shows it. */}
                                        <p className="text-xs text-base-content/70 mt-0.5">
                                            {t('app.notApplicableHint')}
                                        </p>
                                    </div>
                                )}
                                <div className={applicable ? 'space-y-4' : 'space-y-4 opacity-60'}>
                                    {entries.map(([key, config]) => {
                                        const hasOverride = key in overrides;
                                        const globalDefault = defaults?.[key] ?? config.default;
                                        const currentValue = hasOverride ? overrides[key] : globalDefault;
                                        // Live, render-time hint (same spirit as getGroupApplicability):
                                        // when this challenge allows fewer photos than the schedule
                                        // covers, the schedule end-aligns at runtime (scheduleRemap) —
                                        // say so here, where a user puzzled by a fill time would look.
                                        // The `>= 2` gate does double duty. Null guard: `challenge`
                                        // goes null when it drops off the live 60s poll while the
                                        // modal is open (App.jsx derives it as find(...) ?? null), and
                                        // without the gate getScheduleShift would treat max as 0 and
                                        // render the hint into a null dereference. Accuracy guard: on
                                        // a single-photo challenge every remapped row lands below
                                        // count 2 and is dropped, so no image time governs anything —
                                        // a "final photo uses the Image N time" hint would be false.
                                        const scheduleShift =
                                            key === 'autoFillSchedule' &&
                                            Number.isInteger(challenge?.max_photo_submits) &&
                                            challenge.max_photo_submits >= 2
                                                ? getScheduleShift(currentValue, challenge.max_photo_submits)
                                                : 0;

                                        return (
                                            <div key={key} className="form-control">
                                                <label className="label">
                                                    <span className="label-text font-medium">{t(config.label)}</span>
                                                    <div className="flex gap-1">
                                                        {hasOverride ? (
                                                            <span className="badge badge-accent badge-xs">
                                                                {t('app.overridden')}
                                                            </span>
                                                        ) : (
                                                            <span className="badge badge-ghost badge-xs">
                                                                {t('app.usingGlobal')}
                                                            </span>
                                                        )}
                                                    </div>
                                                </label>
                                                <p className="text-xs text-base-content/60 mb-2">
                                                    {t(config.description)}
                                                </p>
                                                <SettingInput
                                                    settingKey={key}
                                                    config={config}
                                                    value={currentValue}
                                                    onChange={handleOverrideChange}
                                                    onReset={applicable && hasOverride ? handleClearOverride : null}
                                                    disabled={!applicable}
                                                />
                                                {scheduleShift > 0 && (
                                                    <p className="text-xs text-info mt-1">
                                                        {t('app.autoFillScheduleShiftHint')
                                                            .replace('{0}', String(challenge.max_photo_submits))
                                                            .replace(
                                                                '{1}',
                                                                String(challenge.max_photo_submits + scheduleShift),
                                                            )}
                                                    </p>
                                                )}
                                                {scheduledFillHints(key).map((hint) => (
                                                    <p key={hint.text} className={`text-xs mt-1 ${hint.tone}`}>
                                                        {hint.text}
                                                    </p>
                                                ))}
                                                <p className="text-xs text-base-content/40 mt-1">
                                                    {t('app.globalDefault')}:{' '}
                                                    {formatSettingDefault(globalDefault, config, t)}
                                                </p>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}

                    {/* Action Buttons */}
                    <ModalActionRow
                        bordered
                        onSave={handleSave}
                        saving={saving}
                        onSecondary={handleClearAll}
                        secondaryLabel={t('app.clearAll')}
                        secondaryIcon="trash"
                        onCancel={onClose}
                    />
                </div>
            )}
        </Modal>
    );
}
