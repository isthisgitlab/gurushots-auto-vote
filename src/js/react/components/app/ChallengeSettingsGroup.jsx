import { useTranslation } from '@/contexts/TranslationContext';
import { SETTINGS_GRID_CLASS, SETTING_CELL_CLASS } from '@/utils/groupSettings';
import { getGroupApplicability } from '@/utils/challengeApplicability';
import { formatSettingDefault } from '@/utils/formatters';
import { getScheduleShift } from '../../../services/scheduleRemap';
import { SettingHelp } from '@/components/ui/SettingHelp';
import { SettingInput, SettingLabel } from './SettingInput';
import { SettingHintList } from './SettingHints';

/** Where a setting's shown value comes from: override, title-rule profile, or the global default. */
function ValueSourceBadge({ hasOverride, hasProfileValue }) {
    const { t } = useTranslation();
    if (hasOverride) return <span className="badge badge-accent badge-xs">{t('app.overridden')}</span>;
    if (hasProfileValue) return <span className="badge badge-info badge-xs">{t('app.usingProfile')}</span>;
    return <span className="badge badge-ghost badge-xs">{t('app.usingGlobal')}</span>;
}

/**
 * How many image slots the auto-fill schedule shifts by on this challenge.
 * Live, render-time hint (same spirit as getGroupApplicability): when this
 * challenge allows fewer photos than the schedule covers, the schedule
 * end-aligns at runtime (scheduleRemap) — say so where a user puzzled by a
 * fill time would look.
 *
 * The `>= 2` gate does double duty. Null guard: `challenge` goes null when it
 * drops off the live 60s poll while the modal is open (App.jsx derives it as
 * find(...) ?? null), and without the gate getScheduleShift would treat max as
 * 0 and render the hint into a null dereference. Accuracy guard: on a
 * single-photo challenge every remapped row lands below count 2 and is
 * dropped, so no image time governs anything — a "final photo uses the Image
 * N time" hint would be false.
 */
function scheduleShiftOf(key, value, challenge) {
    if (key !== 'autoFillSchedule') return 0;
    const max = challenge?.max_photo_submits;
    return Number.isInteger(max) && max >= 2 ? getScheduleShift(value, max) : 0;
}

function ChallengeSettingCell({ settingKey: key, config, applicable, challenge, defaults, form, hintsFor }) {
    const { t } = useTranslation();
    const hasOverride = key in form.overrides;
    const hasProfileValue = Object.prototype.hasOwnProperty.call(form.profileValues, key);
    const currentValue = hasOverride ? form.overrides[key] : form.inheritedOf(key);
    const scheduleShift = scheduleShiftOf(key, currentValue, challenge);
    const inputId = `challenge-setting-${key}`;

    return (
        <div className={SETTING_CELL_CLASS}>
            <SettingLabel inputId={inputId} type={config.type}>
                <span className="label-text font-medium">{t(config.label)}</span>
                <div className="flex gap-1">
                    <ValueSourceBadge hasOverride={hasOverride} hasProfileValue={hasProfileValue} />
                </div>
            </SettingLabel>
            <p className="text-xs text-base-content/60 mb-2">{t(config.description)}</p>
            <SettingHelp helpKey={config.helpKey} />
            <SettingInput
                id={inputId}
                settingKey={key}
                config={config}
                value={currentValue}
                onChange={form.changeOverride}
                onReset={applicable && hasOverride ? form.clearOverride : null}
                disabled={!applicable}
            />
            {scheduleShift > 0 && (
                <p className="text-xs text-info mt-1">
                    {t('app.autoFillScheduleShiftHint')
                        .replace('{0}', String(challenge.max_photo_submits))
                        .replace('{1}', String(challenge.max_photo_submits + scheduleShift))}
                </p>
            )}
            <SettingHintList hints={hintsFor(key)} />
            <p className={`text-xs mt-1 ${hasOverride ? 'text-base-content/70' : 'text-base-content/40'}`}>
                {t('app.globalDefault')}: {formatSettingDefault(defaults?.[key] ?? config.default, config, t)}
            </p>
        </div>
    );
}

/**
 * One settings group of the per-challenge modal. A group whose action can no
 * longer apply to this challenge (boost/turbo already used, all entry slots
 * full) is greyed out and its inputs disabled — a live, render-time hint
 * derived from the challenge prop, never persisted.
 *
 * `form` is useChallengeOverrides' state; `hintsFor(key)` the modal's
 * per-setting hint resolver.
 */
export function ChallengeSettingsGroup({ id, label, entries, challenge, defaults, form, hintsFor }) {
    const { t } = useTranslation();
    const { applicable, reasonKey } = getGroupApplicability(id, challenge);
    // When a group can't apply, tie its heading + reason note to the section
    // via role="group"/aria-* so assistive tech announces *why* the inputs are
    // disabled, not just that they are (WCAG 1.3.1 — the relationship must be
    // programmatic, not only visual).
    const headingId = `challenge-group-${id}`;
    const reasonId = applicable ? undefined : `challenge-group-reason-${id}`;

    return (
        <div
            role={applicable ? undefined : 'group'}
            aria-labelledby={applicable ? undefined : headingId}
            aria-describedby={reasonId}
        >
            <h5
                id={headingId}
                className="font-semibold text-base mb-3 border-b border-base-300 pb-2 flex items-center justify-between gap-2"
            >
                <span>{t(label)}</span>
                {!applicable && <span className="badge badge-ghost badge-xs">{t('app.notApplicable')}</span>}
            </h5>
            {/* Heading, badge and reason note stay at full opacity so the *why*
                remains readable; only the inert inputs below are dimmed. Dimming
                the whole group would compound with the muted text colours and
                push the explanation below WCAG AA contrast. */}
            {!applicable && (
                <div id={reasonId} className="mb-3">
                    <p className="text-xs text-base-content/80">{t(reasonKey)}</p>
                    {/* Reassure that a stored override on this (now-inert) group is
                        not lost — the "Overridden" badge below still shows it. */}
                    <p className="text-xs text-base-content/70 mt-0.5">{t('app.notApplicableHint')}</p>
                </div>
            )}
            <div className={applicable ? SETTINGS_GRID_CLASS : `${SETTINGS_GRID_CLASS} opacity-60`}>
                {entries.map(([key, config]) => (
                    <ChallengeSettingCell
                        key={key}
                        settingKey={key}
                        config={config}
                        applicable={applicable}
                        challenge={challenge}
                        defaults={defaults}
                        form={form}
                        hintsFor={hintsFor}
                    />
                ))}
            </div>
        </div>
    );
}
