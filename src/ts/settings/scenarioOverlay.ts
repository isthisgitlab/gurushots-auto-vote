/**
 * The scenario phase-settings overlay: while a challenge is in a phase of its
 * assigned scenario, that phase's `settings` win over every other layer for
 * that challenge (the manual per-challenge override included) — the scenario
 * is the user's plan for it. Leaving the phase, or the scenario, returns every
 * setting to its normal value; nothing is ever copied into stored overrides.
 *
 * No overlay applies when the challenge's scenario state is unreadable, was
 * started for a different scenario, or sits in a phase the scenario no longer
 * has — the engine halts such a challenge, and the settings stay normal.
 */

import { scenarioStateLedger, mockScenarioStateLedger } from '../scenarioStateStore';
import { normalizeProfileName } from './profileStore';
import { findStoredScenario, hasStoredScenarios } from './scenarios';

import type { AppSettings } from '../types/settings';

// Mock mode keeps scenario state in memory only (it must never touch the real
// scenarioState.json), so the overlay reads the same ledger the mock pass uses.
/** @param settings */
const ledgerFor = (settings: AppSettings) => (settings.mock === true ? mockScenarioStateLedger : scenarioStateLedger);

/**
 * The active phase's settings for a challenge, or null.
 *
 * @param settings - the loaded settings blob
 * @param resolveScenarioName - the challenge's `scenario` setting,
 *   resolved without the overlay (only called when any scenario is stored)
 */
const scenarioPhaseSettings = (
    settings: AppSettings,
    challengeId: string,
    resolveScenarioName: () => string,
): Record<string, unknown> | null => {
    if (!hasStoredScenarios(settings)) return null;
    const name = resolveScenarioName();
    if (!name) return null;
    const scenario = findStoredScenario(settings, name);
    if (!scenario) return null;
    const { corrupt, state } = ledgerFor(settings).get(challengeId);
    if (corrupt || !state || normalizeProfileName(state.scenario) !== normalizeProfileName(scenario.name)) return null;
    return scenario.phases[state.phase]?.settings ?? null;
};

export { scenarioPhaseSettings };
