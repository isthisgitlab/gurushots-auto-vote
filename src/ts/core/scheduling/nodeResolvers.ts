/**
 * Node-side resolvers for the shared cadence math (./thresholdWindow).
 *
 * On Electron main / CLI / Android headless the settings facade is available
 * synchronously, so per-challenge values come straight from it. The GUI
 * WebView has its own async variants over IPC in
 * src/ts/core/autovote/resolvers.ts — same shape, different transport.
 */

import * as settings from '../settings';
import { getScenarioStatus, scenarioWakeInput, ledgerForMode } from '../services/scenarioStatus';
import { isManualPhotosOnly } from '../services/manualPhotosOnly';
import { captureInstallationTimezone } from '../services/installationTimezone';
import { getAutoClaimStatus } from '../services/autoClaim';
import { getNextMissionExpiry } from '../services/missions';
import { listOpenChallenges } from '../services/openChallengeCache';
import { hasStage } from '../services/scenarioRunner/lifecycle';
import { platform } from '../platform/port';
import { INSTALLATION_KEY } from '../scenarioStateStore';

import type {
    ResolveThreshold,
    ResolveFinalWindowTopUp,
    ResolveBoostPrefill,
    ResolveCurrencyAuto,
    ResolveScenarioWake,
    ResolveAutoSubmitClock,
    ResolveAutoSubmitSchedule,
    ResolveAccountWake,
} from './thresholdWindow';
import type { ResolveScheduledFill } from './scheduledFill';
import type { ConfigApp } from '../types/config';
import type { RuleTiming } from '../voting/currencyAuto';

/**
 * The app settings one cadence decision runs on, captured once as the decision starts: the saved app block with the
 * installation's cadence settings over it (the check frequency and the time zone: the saved ones, or the installation
 * scenario's published phase over them). A decision keeps what it captured, so a publication that lands while it runs
 * applies from the next decision, and a time zone is never changed under a cycle in flight. Throws when one of them is
 * unavailable (the phase overlays it and no valid publication stands): the saved value never takes its place, and the chain's
 * own degraded path answers with a plain retry beat, saying so.
 */
const loadCadenceSettings = (): ConfigApp => {
    const captured = settings.captureInstallationSettings(['timezone', 'checkFrequencyMin', 'checkFrequencyMax']);
    if (!captured.ok) throw new Error(`${captured.key} is unavailable (${captured.reason})`);
    return { ...settings.loadSettings().app, ...captured.values };
};

// Per-challenge lastMinuteThreshold for the shared threshold math. A challenge whose scenario settings are unavailable
// (settings.scenarioSubjectAvailable) has no threshold to wake for: NaN is compared with nothing, so it is left out of
// the decision and the others keep theirs. The resolvers below are fail-soft (a throw skips the challenge), which is
// what their reads of an unavailable challenge do (ScenarioSettingUnavailableError).
const resolveThreshold = ((challengeId: string) =>
    settings.scenarioSubjectAvailable(challengeId) === false
        ? Number.NaN
        : settings.getEffectiveSetting('lastMinuteThreshold', challengeId)) satisfies ResolveThreshold;

// Per-challenge scheduled-fill config for the cadence cap (./scheduledFill.ts).
// Both trigger values are LISTS and are passed RAW — scheduledFill.ts owns the
// Array.isArray/Number guards (one normalization site). No Number() coercion
// here: Number([14400]) happens to work via the single-element-array quirk,
// but Number([14400, 36000]) is NaN, which would silently kill the cadence
// cap for exactly the flagship two-offset case.
const resolveScheduledFill = ((challengeId: string) => ({
    enabled: settings.getEffectiveSetting('useScheduledFill', challengeId) === true,
    timesOfDay: settings.getEffectiveSetting('scheduledFillTime', challengeId),
    beforeEndSecs: settings.getEffectiveSetting('scheduledFillBeforeEnd', challengeId),
})) satisfies ResolveScheduledFill;

const resolveAutoSubmitClock = ((challengeId: string) => ({
    enabled: settings.getEffectiveSetting('autoSubmit', challengeId) === true,
    manualPhotosOnly: isManualPhotosOnly(settings, challengeId),
    times: settings.getEffectiveSetting('autoSubmitTime', challengeId),
    windowMinutes: settings.getEffectiveSetting('autoSubmitWindowMinutes', challengeId),
})) satisfies ResolveAutoSubmitClock;

// A phase's dynamic submit schedule, as its owner published it, is what the deadlines are worked out from while the phase holds
// it (`resolved`); one that cannot be read gives no deadline (unknown evidence supplies none), and the saved schedule never
// takes its place.
const resolveAutoSubmitSchedule = ((challengeId: string) => {
    const phase = settings.getPhaseSchedules(challengeId);
    return {
        enabled: settings.getEffectiveSetting('autoSubmit', challengeId) === true && phase.kind !== 'unavailable',
        manualPhotosOnly: isManualPhotosOnly(settings, challengeId),
        schedule: settings.getEffectiveSetting('autoSubmitSchedule', challengeId),
        ...(phase.kind === 'resolved' && phase.schedules.submit ? { resolved: phase.schedules.submit } : {}),
    };
}) satisfies ResolveAutoSubmitSchedule;

// Per-challenge pre-final-window top-up config for the cadence cap (./thresholdWindow/leadWindows.ts).
// Enabled only when BOTH the final-window feature and this opt-in are on — matching the
// rule engine's gate in _runVotingRules (services/decisions/ruleEngine.ts). leadSec is minutes → seconds and
// durationSec is the configurable final-window length. Both are validated settings; thresholdWindow/leadWindows.ts
// also guards them because the GUI's async resolvers hand it values over IPC.
const resolveFinalWindowTopUp = ((challengeId: string) => ({
    enabled:
        settings.getEffectiveSetting('voteBeforeFinalWindow', challengeId) === true &&
        settings.getEffectiveSetting('useFinalWindowExposure', challengeId) === true,
    leadSec: settings.getEffectiveSetting('voteBeforeFinalWindowLeadMin', challengeId) * 60,
    durationSec: settings.getEffectiveSetting('finalWindowDuration', challengeId),
})) satisfies ResolveFinalWindowTopUp;

// Per-challenge pre-boost fill config for the cadence cap (./thresholdWindow/leadWindows.ts).
// Enabled only when the opt-in and autoBoost are on AND onlyBoost is off — matching the
// rule engine, so the scheduler never wakes for a fill the rule would decline. onlyBoost
// is part of the gate because it blocks every vote ahead of the pre-boost branch in
// _runVotingRules, which would otherwise make this cap wake a cycle that can only no-op.
// Both boost windows are passed through as numbers because the apply instant depends on
// the challenge's live boost state, which only thresholdWindow/leadWindows.ts sees; it applies the
// `0 = off` sentinel and also guards an out-of-range leadSec, because the GUI's async resolvers hand it values over IPC.
const resolveBoostPrefill = ((challengeId: string) => ({
    enabled:
        settings.getEffectiveSetting('voteBeforeBoost', challengeId) === true &&
        settings.getEffectiveSetting('autoBoost', challengeId) === true &&
        settings.getEffectiveSetting('onlyBoost', challengeId) !== true,
    leadSec: settings.getEffectiveSetting('voteBeforeBoostLeadMin', challengeId) * 60,
    boostTimeSec: settings.getEffectiveSetting('boostTime', challengeId),
    keyUnlockedBoostTimeSec: settings.getEffectiveSetting('keyUnlockedBoostTime', challengeId),
})) satisfies ResolveBoostPrefill;

// Per-challenge currency-automation timing for the cadence cap (./thresholdWindow/ruleWakes.ts):
// each ENABLED rule's three timing conditions, null for a rule that is off. The
// enable keys resolve through global defaults, profiles and challenge overrides.
// Disabled rules resolve to null and never shorten the wait.
const currencyTimingOf = (
    enableKey: 'autoKeyUnlock' | 'autoSwap' | 'autoExposureFill',
    prefix: 'autoKey' | 'autoSwap' | 'autoExposureFill',
    challengeId: string,
): RuleTiming | null =>
    settings.getEffectiveSetting(enableKey, challengeId) === true
        ? {
              afterStartSec: settings.getEffectiveSetting(`${prefix}AfterStart`, challengeId),
              beforeEndSec: settings.getEffectiveSetting(`${prefix}BeforeEnd`, challengeId),
              afterPercent: settings.getEffectiveSetting(`${prefix}AfterPercent`, challengeId),
          }
        : null;

const resolveCurrencyAuto = ((challengeId: string) => ({
    key: currencyTimingOf('autoKeyUnlock', 'autoKey', challengeId),
    // Manual Only: no swap ever fires on its own, so the scheduler has no wake to hold for it.
    swap: isManualPhotosOnly(settings, challengeId) ? null : currencyTimingOf('autoSwap', 'autoSwap', challengeId),
    fill: currencyTimingOf('autoExposureFill', 'autoExposureFill', challengeId),
})) satisfies ResolveCurrencyAuto;

// Per-challenge scenario and runtime state for the scenario boundary
// (./thresholdWindow/ruleWakes.ts computes the instant with the engine's own nextWakeAt).
const resolveScenarioWake = ((challengeId: string) =>
    scenarioWakeInput(getScenarioStatus(challengeId))) satisfies ResolveScenarioWake;

// The account's own boundaries, read once as a decision starts: the installation scenario this runtime owns (looking ahead to
// `discoverUpcomingHours`, never to a challenge's close), the open challenges whose scenario has pre-join rules, the claim
// throttle and the earliest mission expiry the last read showed. The time zone is the installation's effective one, captured
// once for the whole evaluation; one that cannot be read leaves out what needs it.
const resolveAccountWake = (() => {
    const timezone = captureInstallationTimezone();
    const assignment = settings.getInstallationScenario();
    const scenario = assignment ? settings.getScenario(assignment.scenario) : null;
    const hours = settings.getEffectiveSetting('discoverUpcomingHours', 'global');
    const record = ledgerForMode().get(INSTALLATION_KEY);
    const owned =
        timezone !== null &&
        assignment !== null &&
        scenario?.scope === 'installation' &&
        platform().capabilities.executor === assignment.executor &&
        // The assignment's generation is the one the progress is at: a former owner's runtime wakes for nothing.
        settings.installationGeneration() === assignment.generation &&
        !record.corrupt &&
        Number.isFinite(hours);
    const now = Math.floor(Date.now() / 1000);
    const claim = getAutoClaimStatus();
    return {
        installation: owned
            ? {
                  scenario,
                  state:
                      record.state && record.state.scenario.toLowerCase() === scenario.name.toLowerCase()
                          ? record.state
                          : null,
                  timezone,
                  horizon: now + hours * 3600,
              }
            : null,
        candidates:
            timezone === null
                ? []
                : listOpenChallenges().flatMap((challenge) => {
                      const name = settings.getEffectiveSetting('scenario', String(challenge.id)) || '';
                      const doc = name ? settings.getScenario(name) : null;
                      return doc && hasStage(doc, 'preJoin') && Number(challenge.close_time) > now
                          ? [{ challenge, scenario: doc, timezone }]
                          : [];
                  }),
        claimAt: claim.enabled && claim.nextClaimAt > 0 ? Math.ceil(claim.nextClaimAt / 1000) : null,
        missionExpiry: getNextMissionExpiry(),
    };
}) satisfies ResolveAccountWake;

export {
    loadCadenceSettings,
    resolveAccountWake,
    resolveScenarioWake,
    resolveThreshold,
    resolveScheduledFill,
    resolveAutoSubmitClock,
    resolveAutoSubmitSchedule,
    resolveFinalWindowTopUp,
    resolveBoostPrefill,
    resolveCurrencyAuto,
};
