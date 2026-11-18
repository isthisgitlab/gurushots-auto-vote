/**
 * CLI scenario commands — list, template, import (with the same preview and
 * --yes confirmation the GUI's import dialog has), export, rename, delete,
 * plus per-challenge status, reset and dry run. Each reuses the scenario IPC
 * handlers called with a null event (the Capacitor bridge shape), so the CLI
 * and the GUI cannot drift. Every command returns its exit code.
 */

import * as fs from 'node:fs';
import * as logger from '../../../core/logger';
import { formatDateTime } from '../../../core/dateFormat';
import { SCENARIO_TEMPLATES } from '../../../core/scenarios/templates';
import { SCENARIO_CAPS, VOCABULARY_REFERENCE } from '../../../core/scenarios/vocabulary';
import { finiteOr } from '../../../core/numbers';
import { escapeTerminalUnsafe, stripTerminalControl } from '../../../core/format/logSafe';

// Built lazily so requiring this module (e.g. for `help`) does not construct
// the handler set or pull in its transitive dependencies.
import type { NullEventHandlers } from '../../../core/types/cli';
import type { ScenarioIssue } from '../../../core/settings/scenarioSchema';
import type { SimulationEvent } from '../../../core/types/scenario';
import type { ExprValue } from '../../../core/scenarios/expressions';
import type { ValueState } from '../../../core/scenarios/valueState';
import type * as scenarios_handlersModule from '../../../core/ipc/scenarios.handlers';
import type * as settingsModule from '../../../core/settings';
import { errorMessage } from '../../../core/errorMessage';
type ScenarioHandlers = NullEventHandlers<ReturnType<typeof scenarios_handlersModule.buildHandlers>>;
let _handlers: ScenarioHandlers | undefined;
const handlers = (): ScenarioHandlers =>
    (_handlers ??= (
        require('../../../core/ipc/scenarios.handlers') as typeof import('../../../core/ipc/scenarios.handlers')
    ).buildHandlers());

const ui = () => logger.withCategory('ui');

/** @param sec - unix seconds */
const at = (sec: number | null | undefined) => {
    const seconds = finiteOr(sec, null);
    return seconds === null ? 'nothing time-based pending' : formatDateTime(new Date(seconds * 1000));
};

/**
 * Print a failed result — its issues when validation failed — and yield exit code 1.
 * A challenge whose data cannot be read (the handlers' `challenge-data-incomplete`
 * refusal) reads as the reason, never the raw code.
 */
const reportFailure = (result: { success?: boolean; error?: unknown; issues?: ScenarioIssue[] }, what: string) => {
    const reason =
        result.error === 'challenge-data-incomplete'
            ? "The challenge's data cannot be read, so the scenario cannot be checked."
            : result.error;
    ui().error(`${what}: ${reason}`);
    for (const issue of result.issues ?? []) ui().error(`  ${issue.path || '(document)'}: ${issue.message}`);
    return 1;
};

/**
 * Write the JSON document `json` to `file`, or print it when no file is given. Both get the same
 * text: characters that could drive a terminal or hide what is shown are escaped, not removed, so
 * the document stays valid and means the same either way.
 */
const output = (json: string, file: string | null | undefined) => {
    const text = escapeTerminalUnsafe(json);
    if (!file) {
        // A document the user asked to see (or pipe): printed verbatim, with its line breaks, on the
        // console only; the log file's one-line entries would flatten it. It holds no credentials,
        // and redaction would corrupt the JSON. The console adds the final newline.
        logger.printDocument(text.replace(/\n$/, ''));
        return 0;
    }
    try {
        fs.writeFileSync(file, text, 'utf8');
        ui().success(`Written to ${file}`);
        return 0;
    } catch (error) {
        ui().error(`Could not write ${file}: ${errorMessage(error)}`);
        return 1;
    }
};

const listScenarios = async () => {
    const result = await handlers()['get-scenarios']();
    if (!result.success) return reportFailure(result, 'Could not list scenarios');
    const names = Object.keys(result.scenarios);
    ui().info(names.length ? `Scenarios (${names.length}):` : 'No scenarios yet.');
    for (const name of names) {
        const scenario = result.scenarios[name];
        // Stored (and imported) text: a control or bidi character in it must not reach the terminal.
        const shown = stripTerminalControl(name);
        ui().info(
            `  • ${shown} — ${Object.keys(scenario.phases).length} phase(s), starts in "${stripTerminalControl(scenario.start)}"`,
        );
        if (scenario.description) ui().info(`      ${stripTerminalControl(scenario.description)}`);
    }
    ui().info(`Templates: ${SCENARIO_TEMPLATES.map((t) => t.id).join(', ')} (scenario-template <id> [file])`);
    return 0;
};

const scenarioTemplate = async (id: string, file?: string) => {
    const template = SCENARIO_TEMPLATES.find((t) => t.id === id);
    if (!template) {
        ui().error(`Unknown template "${id}". Templates: ${SCENARIO_TEMPLATES.map((t) => t.id).join(', ')}`);
        return 1;
    }
    return output(`${JSON.stringify(template.scenario, null, 2)}\n`, file);
};

const printPreview = ({
    preview,
    exists,
}: {
    preview: ReturnType<typeof settingsModule.describeScenario>;
    exists: boolean;
}) => {
    // The scenario is a file the user imports: its names and text must not drive the terminal.
    const name = stripTerminalControl(preview.name);
    ui().info(`Scenario "${name}" — starts in phase "${stripTerminalControl(preview.start)}"`);
    if (preview.description) ui().info(`  ${stripTerminalControl(preview.description)}`);
    for (const phase of preview.phases) {
        const overlay = phase.settings.length ? `, settings: ${phase.settings.join(', ')}` : '';
        ui().info(`  • phase ${stripTerminalControl(phase.name)}: ${phase.rules} rule(s)${overlay}`);
    }
    if (preview.spending.length) {
        ui().info('  Spends:');
        for (const spend of preview.spending) {
            const where = `${stripTerminalControl(spend.phase)} → ${stripTerminalControl(spend.rule)}`;
            ui().info(`    - ${spend.action} (${where})`);
        }
    } else {
        ui().info('  Spends nothing.');
    }
    const limits = Object.entries(preview.limits);
    ui().info(limits.length ? `  Limits: ${limits.map(([k, v]) => `${v} ${k}`).join(', ')}` : '  No spending limits.');
    for (const { phase, key } of preview.flagged) {
        const named = stripTerminalControl(phase);
        ui().warning(
            key === 'chosenPhotos'
                ? `  Phase ${named} sets chosenPhotos — photo ids from another account will not match your photos.`
                : `  Phase ${named} sets chosenPhotosOnly — a challenge with no usable chosen photo is skipped.`,
        );
    }
    if (exists) ui().warning(`  A scenario named "${name}" already exists — importing needs --overwrite.`);
};

const importScenarioCmd = async (
    file: string,
    { overwrite = false, yes = false }: { overwrite?: boolean; yes?: boolean } = {},
) => {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        ui().error(`Could not read ${file}: ${errorMessage(error)}`);
        return 1;
    }
    const preview = await handlers()['preview-scenario-import'](null, text);
    if (!preview.success) return reportFailure(preview, `${file} is not a valid scenario`);
    printPreview(preview);
    if (!yes) {
        ui().info(
            `Nothing imported yet. To import, re-run: import-scenario ${file}${overwrite ? ' --overwrite' : ''} --yes`,
        );
        return 0;
    }
    // An overwrite states the revision of the scenarios it read: another editor's change is not replaced unseen.
    const library = overwrite ? await handlers()['get-scenarios']() : null;
    const expectedDefinitionRevision = library?.success ? (library.revision ?? undefined) : undefined;
    const result = await handlers()['import-scenario'](null, text, { overwrite, expectedDefinitionRevision });
    if (!result.success) return reportFailure(result, 'Import failed');
    ui().success(`Imported scenario "${result.name}".`);
    return 0;
};

const exportScenarioCmd = async (name: string, file?: string) => {
    const result = await handlers()['export-scenario'](null, name);
    if (!result.success) return reportFailure(result, `Could not export "${name}"`);
    if (result.omitted?.length) {
        const note = `Left out of the export (they belong to your account): ${result.omitted.join(', ')}`;
        // With no file the JSON goes to stdout, where it is often piped: the note goes to stderr so
        // the document stays valid.
        if (file) ui().warning(note);
        else logger.printStderr(note);
    }
    // A successful export always carries its JSON text.
    return output(result.json as string, file);
};

const renameScenarioCmd = async (oldName: string, newName: string) => {
    const result = await handlers()['rename-scenario'](null, oldName, newName);
    if (!result.success) return reportFailure(result, `Could not rename "${oldName}"`);
    ui().success(`Renamed "${oldName}" to "${result.name}" — its assignments moved with it.`);
    return 0;
};

const deleteScenarioCmd = async (name: string) => {
    const result = await handlers()['delete-scenario'](null, name);
    if (!result.success) return reportFailure(result, `Could not delete "${name}"`);
    ui().success(`Deleted "${name}" and cleared its assignments.`);
    return 0;
};

const scenarioStatusCmd = async (challengeId: string) => {
    const status = await handlers()['get-scenario-status'](null, challengeId);
    if (!status.success) return reportFailure(status, 'Could not read the scenario status');
    if (!status.assigned) {
        ui().info(`Challenge ${challengeId} has no scenario.`);
        return 0;
    }
    if (!status.scenario) {
        ui().warning(`Challenge ${challengeId} is assigned "${status.assigned}", which does not exist — nothing runs.`);
        return 0;
    }
    if (status.corrupt === 'unloaded') {
        ui().error(UNLOADED);
        return 1;
    }
    if (status.corrupt) {
        ui().error(
            status.corrupt === 'file'
                ? 'The saved scenario progress is unreadable. Reset the progress of every challenge (scenario-reset --all) to start the plans again.'
                : `This challenge’s saved scenario progress is unreadable. Reset it (scenario-reset --challenge=${challengeId}) to start the plan again.`,
        );
        return 1;
    }
    const { state } = status;
    ui().info(`Scenario "${status.scenario.name}" on challenge ${challengeId}`);
    // A plan that has not started says it starts once Manual Only is off; the paused line is for a started one.
    if (status.manualOnly && state) ui().info('  Paused (Manual Only): no step runs and no check is due.');
    if (!state) {
        ui().info(
            `  Not started yet — it starts in phase "${status.scenario.start}" ${status.manualOnly ? 'once Manual Only is off' : 'on the next voting pass'}.`,
        );
        return 0;
    }
    ui().info(`  Phase: ${state.phase} (since ${at(state.phaseEnteredAt)})`);
    const memory = Object.entries(state.memory);
    if (memory.length) ui().info(`  Remembered: ${memory.map(([slot, id]) => `${slot}=${id}`).join(', ')}`);
    ui().info(
        `  Spent: ${state.spent.swaps ?? 0} swaps, ${state.spent.keys ?? 0} keys, ${state.spent.fills ?? 0} fills`,
    );
    if (state.inFlight)
        ui().info(`  Interrupted rule "${state.inFlight.ruleId}" resumes at action ${state.inFlight.actionIndex + 1}`);
    if (state.lastAction)
        ui().info(
            `  Last action: ${state.lastAction.action} (${state.lastAction.ruleId}) at ${at(state.lastAction.at)}`,
        );
    if (state.lastError)
        ui().warning(`  Last problem: ${stripTerminalControl(state.lastError.message)} (${at(state.lastError.at)})`);
    return 0;
};

const RESET_COST =
    'Resetting may spend again an action whose outcome is unknown (GuruShots gave no answer, or the app could not record it), and it restarts the scenario spend counter.';

const RESET_BUSY =
    'This challenge’s scenario is being run, or the saved scenario progress is being updated, right now (by the app or by another process). Nothing was changed. Try again in a moment.';

const RESET_ALL_BUSY =
    'The saved scenario progress is being updated right now (by the app or by another process). Nothing was changed. Try again in a moment.';

const RESET_LOCKS_UNAVAILABLE =
    'The app cannot create its lock files in its data folder, so it cannot do this safely. Nothing was changed. Check the folder’s permissions and the free disk space (logs --error has the details), then try again.';

const RESET_NOT_SAVED =
    'The reset could not be saved (the storage is full or not writable — logs --error has the details), so nothing was changed. Try again.';

const UNLOADED =
    'The saved scenario progress could not be loaded yet; the app retries — reopen the app if it persists. Nothing is reset.';

const scenarioResetCmd = async (challengeId: string) => {
    const result = await handlers()['reset-scenario-state'](null, challengeId);
    if (!result.success && result.error === 'busy') {
        ui().error(RESET_BUSY);
        return 1;
    }
    if (!result.success && result.error === 'locks-unavailable') {
        ui().error(RESET_LOCKS_UNAVAILABLE);
        return 1;
    }
    if (!result.success && (result.error === 'not-saved' || result.error === 'state-unloaded')) {
        ui().error(result.error === 'not-saved' ? RESET_NOT_SAVED : UNLOADED);
        return 1;
    }
    if (!result.success && result.error === 'state-unreadable') {
        ui().error(
            `The saved scenario progress cannot be read, so it can only be reset for every challenge at once: scenario-reset --all. That forgets the progress of every challenge, including which rules already ran and the spend counters. ${RESET_COST} Nothing was changed.`,
        );
        return 1;
    }
    if (!result.success) return reportFailure(result, 'Could not reset the scenario');
    ui().success(
        `Scenario progress reset for challenge ${challengeId} — the plan starts again on the next voting pass, and the rules that already ran can run (and spend) again. ${RESET_COST}`,
    );
    return 0;
};

const scenarioResetAllCmd = async () => {
    const result = await handlers()['reset-all-scenario-state'](null);
    if (!result.success && result.error === 'busy') {
        ui().error(RESET_ALL_BUSY);
        return 1;
    }
    if (!result.success && result.error === 'locks-unavailable') {
        ui().error(RESET_LOCKS_UNAVAILABLE);
        return 1;
    }
    if (!result.success && (result.error === 'not-saved' || result.error === 'state-unloaded')) {
        ui().error(result.error === 'not-saved' ? RESET_NOT_SAVED : UNLOADED);
        return 1;
    }
    if (!result.success) return reportFailure(result, 'Could not reset the scenarios');
    ui().success(
        `Scenario progress reset for every challenge — every plan starts again on the next voting pass, and the rules that already ran can run (and spend) again. ${RESET_COST}`,
    );
    return 0;
};

const scenarioDryRunCmd = async (challengeId: string) => {
    const result = await handlers()['dry-run-scenario'](null, challengeId);
    if (!result.success) return reportFailure(result, 'Dry run failed');
    ui().info(`Scenario "${result.scenario}" — phase ${result.phase}${result.started ? '' : ' (not started yet)'}`);
    if (result.halted) {
        ui().error(`  Halted: ${result.halted}`);
        return 1;
    }
    if (result.manualOnly) {
        ui().info('  Paused (Manual Only): nothing would run now and no check is due.');
        return 0;
    }
    for (const rule of result.explain)
        ui().info(`  [${rule.status}] ${stripTerminalControl(rule.label)}: ${rule.reason}`);
    ui().info(
        result.fire
            ? `  Would run now: ${result.fire.ruleId} → ${result.fire.actions.slice(result.fire.startIndex).join(', ')}`
            : '  Nothing would run now.',
    );
    ui().info(`  Next time-based check: ${at(result.nextWakeAt)}`);
    return 0;
};

const STOP_REASONS: Record<string, string> = {
    horizon: 'the time you asked for is reached',
    idle: 'nothing more is time-based — the plan now waits on live data (votes, rank, boost) the simulation does not know',
    needsEvidence: 'it needs an outcome you have not assumed',
    halted: 'the scenario halts',
    limit: 'the timeline is long — only the first steps are shown',
};

const SIMULATE_USAGE =
    'Usage: scenario-simulate <name> --subject=installation|candidate|active|completed --until=<ISO 8601> [--challenge=<id>] [--assumptions=<file>]';

/** The `--name=value` flags of the command; any other flag, or one given twice, is refused. */
const SIMULATE_FLAGS = ['subject', 'until', 'challenge', 'assumptions'] as const;

type SimulateArgs =
    | { ok: true; name: string; subject: string; until: string; challenge: string | null; assumptions: string | null }
    | { ok: false; message: string };

/**
 * The arguments of `scenario-simulate`: one scenario name, and the flags, each at most once. Says what is missing or extra, in
 * plain words.
 */
const parseSimulateArgs = (argv: string[]): SimulateArgs => {
    const positionals = argv.filter((arg) => !arg.startsWith('--'));
    const flags = new Map<string, string>();
    for (const arg of argv.filter((entry) => entry.startsWith('--'))) {
        const [name, ...value] = arg.slice(2).split('=');
        if (!SIMULATE_FLAGS.some((known) => known === name)) return { ok: false, message: `Unknown option --${name}.` };
        if (flags.has(name)) return { ok: false, message: `--${name} is given twice.` };
        flags.set(name, value.join('='));
    }
    if (positionals.length === 0) return { ok: false, message: 'Name the scenario to simulate.' };
    if (positionals.length > 1)
        return { ok: false, message: 'Name one scenario only (put a name with spaces in quotes).' };
    const subject = flags.get('subject');
    if (!subject) return { ok: false, message: '--subject is missing: installation, candidate, active or completed.' };
    const until = flags.get('until');
    if (!until)
        return {
            ok: false,
            message: '--until is missing: the time to simulate until, as ISO 8601 (2026-12-01T18:00:00Z).',
        };
    const challenge = flags.get('challenge') ?? null;
    if (subject === 'installation' && challenge !== null) {
        return {
            ok: false,
            message: '--challenge is not used with an installation subject: the installation has no challenge.',
        };
    }
    if (subject !== 'installation' && !challenge) {
        return { ok: false, message: `--challenge=<id> is required for a ${subject} subject.` };
    }
    return { ok: true, name: positionals[0], subject, until, challenge, assumptions: flags.get('assumptions') ?? null };
};

const ISO_8601 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** An ISO 8601 date or date and time as unix seconds, or null when it is not one. */
const isoToSeconds = (text: string): number | null => {
    if (!ISO_8601.test(text)) return null;
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

/** The assumptions file as JSON: refused when it is too big (the same bound as an imported scenario), or is not JSON. */
const readAssumptionsFile = (file: string): { ok: true; value: unknown } | { ok: false; message: string } => {
    try {
        if (fs.statSync(file).size > SCENARIO_CAPS.importBytes) {
            return {
                ok: false,
                message: `The assumptions file is larger than ${SCENARIO_CAPS.importBytes / 1024} KB.`,
            };
        }
        return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) as unknown };
    } catch (error) {
        return {
            ok: false,
            message: `The assumptions file could not be read as JSON: ${errorMessage(error) || error}`,
        };
    }
};

const ASSUMPTION_ERRORS: Record<string, string> = {
    'invalid-assumptions':
        'The assumptions are not valid: use { "outcomes": { "<operation>": "success|refused|unclear" }, "snapshots": [...] }.',
    'assumptions-too-large': 'The assumptions are too large.',
    'until-in-past': '--until is already past.',
    'simulation-busy': 'Another simulation is running; try again when it has finished.',
    'scenario-scope-mismatch':
        'This scenario does not fit that subject: installation scenarios run on the installation, challenge scenarios on a challenge.',
    'subjects-unreadable': 'The list that subject comes from could not be read, so nothing was simulated.',
    'challenge-not-found': 'That challenge is not in the list its kind comes from.',
    'unknown-scenario': 'There is no saved scenario with that name.',
};

const eventLine = (event: SimulationEvent): string | null => {
    switch (event.type) {
        case 'operation':
            return `${event.operation} ${event.subject}: ${event.outcome}`;
        case 'rule':
            return `[${stripTerminalControl(event.phase)}] rule ${stripTerminalControl(event.ruleId)} ran`;
        case 'phase':
            return `phase ${stripTerminalControl(event.from)} → ${stripTerminalControl(event.to)}`;
        case 'published':
            return `[${stripTerminalControl(event.phase)}] settings published`;
        case 'notice':
            return `notice: ${stripTerminalControl(event.message)}`;
        case 'preview':
            return null;
    }
};

const printSimulation = (
    result: Extract<Awaited<ReturnType<ScenarioHandlers['simulate-scenario']>>, { success: true }>,
) => {
    const outcomes = Object.entries(result.assumptions.outcomes ?? {});
    ui().info(
        `Scenario "${stripTerminalControl(result.scenario)}" on ${result.subject.kind === 'installation' ? 'the installation' : `${result.subject.kind} challenge ${result.subject.challengeId}`}, until ${at(result.until)}.`,
    );
    ui().info(
        outcomes.length > 0
            ? `  Assumed: ${outcomes.map(([operation, outcome]) => `${operation} ${outcome}`).join(', ')}. Nothing else is assumed.`
            : '  Assumed: nothing — a step that needs an outcome stops the run.',
    );
    if (result.manualOnly) ui().info('  Paused (Manual Only): this is what would run if the switch were off now.');
    const lines = result.events.flatMap((event) => {
        const line = eventLine(event);
        return line === null ? [] : [`  ${at(event.at)}  ${line}`];
    });
    if (lines.length === 0) ui().info('  Nothing would run.');
    for (const line of lines) ui().info(line);
    for (const deadline of result.deadlines) {
        if (deadline.kind === 'submit') ui().info(`  Submit ${deadline.count} by ${at(deadline.at)}`);
        else if (deadline.kind === 'publication') ui().info(`  Settings valid until ${at(deadline.validUntil)}`);
        else ui().info(`  ${deadline.kind} window ${at(deadline.start)} to ${at(deadline.end)}`);
    }
    const preview = result.events.find((event) => event.type === 'preview');
    if (preview) ui().info(`  Next look after that: ${at(preview.at)} (not simulated)`);
    ui().info(`  Stops at ${at(result.stoppedAt)}: ${STOP_REASONS[result.stopReason]}.`);
    if (result.needs) {
        ui().warning(
            `  Needs the outcome of "${result.needs.operation}" for ${result.needs.subject} (${at(result.needs.at)}). Add it to the assumptions file: { "outcomes": { "${result.needs.operation}": "success" } }`,
        );
    }
    if (result.halted) ui().warning(`  ${stripTerminalControl(result.halted)}`);
};

/**
 * `scenario-simulate`: the same request the app's builder makes, built from the flags. Nothing is changed or spent.
 */
const scenarioSimulateCommand = async (argv: string[]) => {
    const args = parseSimulateArgs(argv);
    if (!args.ok) {
        ui().error(args.message);
        ui().info(SIMULATE_USAGE);
        return 1;
    }
    const until = isoToSeconds(args.until);
    if (until === null) {
        ui().error(`--until is not a time ISO 8601 knows: ${escapeTerminalUnsafe(args.until)}`);
        return 1;
    }
    let assumptions: unknown;
    if (args.assumptions !== null) {
        const file = readAssumptionsFile(args.assumptions);
        if (!file.ok) {
            ui().error(file.message);
            return 1;
        }
        assumptions = file.value;
    }
    const result = await handlers()['simulate-scenario'](null, {
        scenario: { name: args.name },
        subject:
            args.subject === 'installation'
                ? { kind: 'installation' }
                : { kind: args.subject, challengeId: args.challenge },
        until,
        ...(assumptions === undefined ? {} : { assumptions }),
    });
    if (!result.success) {
        const known = ASSUMPTION_ERRORS[String(result.error)];
        if (known) {
            ui().error(known);
            return 1;
        }
        return reportFailure(result, 'Simulation failed');
    }
    printSimulation(result);
    return 0;
};

// --- the installation scenario, pause and handoff, photo pools, snapshot and Stop status --------------------------------------
// Each reuses the lifecycle handlers (ipc/scenarioLifecycle.handlers.ts) called with a null event.

const LIFECYCLE_REASONS: Record<string, string> = {
    busy: 'it is in use right now — try again in a moment',
    'unresolved-work': 'a step or a spend is not finished',
    'unresolved-spend': 'a spend may not be finished',
    'rule-in-progress': 'a rule is running',
    'handoff-pending': 'a handover is not finished',
    'state-unreadable': 'the saved progress cannot be read',
    'stale-generation': 'it changed since you looked — read it again',
    'unknown-scenario': 'there is no scenario with that name',
    'incompatible-scope': 'that scenario is not an installation scenario',
    'invalid-executor': 'that is not a runtime name',
    'no-installation': 'the installation has no scenario',
    'no-progress': 'it has no progress yet',
    'invalid-subject': 'that is not a challenge id or "installation"',
    'assignment-unchanged': 'it already has that scenario',
    'not-saved': 'it could not be saved',
    cap: 'the account is at its pool limit',
    invalid: 'the name or the photo ids are not valid',
    'write-failed': 'it could not be saved',
    'not-found': 'there is no pool with that name',
    exists: 'a pool with that name exists',
};

const EXECUTORS = ['electron', 'cli', 'web', 'android-service', 'android-app'] as const;

/** A lifecycle failure in plain words: `what` could not be done, and why. */
const lifecycleFailure = (result: { error?: unknown }, what: string): number => {
    const code = String(result.error);
    ui().error(`Could not ${what}: ${LIFECYCLE_REASONS[code] ?? code}`);
    return 1;
};

const wrongArguments = (usage: string): number => {
    ui().error('Wrong arguments');
    ui().info(usage);
    return 1;
};

type LifecycleArgs = { positionals: string[]; values: Map<string, string>; switches: Set<string> };

/**
 * The arguments of a lifecycle command: positionals, `--name=value` flags and bare `--switch`es, each flag at most once.
 * Null for a flag it does not know, a repeat, a switch with a value, or a value flag with none.
 */
const lifecycleArgs = (
    argv: string[],
    valueFlags: readonly string[] = [],
    switchFlags: readonly string[] = [],
): LifecycleArgs | null => {
    const parsed: LifecycleArgs = { positionals: [], values: new Map(), switches: new Set() };
    for (const arg of argv) {
        if (!arg.startsWith('--')) {
            parsed.positionals.push(arg);
            continue;
        }
        const [name, ...rest] = arg.slice(2).split('=');
        if (switchFlags.includes(name) && rest.length === 0 && !parsed.switches.has(name)) parsed.switches.add(name);
        else if (valueFlags.includes(name) && rest.length > 0 && !parsed.values.has(name))
            parsed.values.set(name, rest.join('='));
        else return null;
    }
    return parsed;
};

/** A generation or an epoch as a whole number, or null. */
const wholeNumber = (text: string | undefined): number | null =>
    text !== undefined && /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;

/** A subject as the handlers name it: `installation` (or `@installation`) is the installation, anything else a challenge id. */
const subjectOf = (word: string): string => (word === 'installation' ? '@installation' : word);

const subjectName = (subject: string): string =>
    subject === '@installation' ? 'the installation' : `challenge ${stripTerminalControl(subject)}`;

const INSTALLATION_USAGE = `Usage: scenario-installation ["<name>"|--clear] [--executor=${EXECUTORS.join('|')}]`;

/**
 * `scenario-installation`: shows the installation's scenario; with a name sets it (run by --executor, else by the runtime it
 * has now, else by the CLI); with --clear clears it.
 */
const scenarioInstallationCommand = async (argv: string[]): Promise<number> => {
    const args = lifecycleArgs(argv, ['executor'], ['clear']);
    const clear = args?.switches.has('clear') === true;
    const executor = args?.values.get('executor');
    if (
        !args ||
        args.positionals.length > 1 ||
        (clear && (args.positionals.length > 0 || executor !== undefined)) ||
        (executor !== undefined && args.positionals.length === 0)
    ) {
        return wrongArguments(INSTALLATION_USAGE);
    }
    const current = await handlers()['get-installation-scenario'](null);
    if (!current.success) return reportFailure(current, 'Could not read the installation scenario');
    const assigned = current.installation;
    if (args.positionals.length === 0 && !clear) {
        ui().info(
            assigned
                ? `Installation scenario: "${stripTerminalControl(assigned.scenario)}", run by ${assigned.executor} (generation ${assigned.generation}).`
                : 'The installation has no scenario.',
        );
        return 0;
    }
    if (current.generation === null)
        return lifecycleFailure({ error: 'state-unreadable' }, 'change the installation scenario');
    if (clear) {
        const cleared = await handlers()['clear-scenario-assignment'](null, '@installation', current.generation);
        if (!cleared.success) return lifecycleFailure(cleared, 'change the installation scenario');
        ui().success('Installation scenario cleared.');
        return 0;
    }
    const name = args.positionals[0];
    const runner = executor ?? assigned?.executor ?? 'cli';
    const set = await handlers()['set-installation-scenario'](
        null,
        name,
        runner as (typeof EXECUTORS)[number],
        current.generation,
    );
    if (!set.success) return lifecycleFailure(set, 'change the installation scenario');
    ui().success(`Installation scenario "${stripTerminalControl(name)}" is set, run by ${runner}.`);
    return 0;
};

const OWNER_USAGE = `Usage: scenario-owner-transfer --executor=${EXECUTORS.join('|')} --generation=<n>`;

/** `scenario-owner-transfer`: hands the installation scenario to another runtime, under the generation the user saw. */
const scenarioOwnerTransferCommand = async (argv: string[]): Promise<number> => {
    const args = lifecycleArgs(argv, ['executor', 'generation']);
    const executor = args?.values.get('executor');
    const generation = wholeNumber(args?.values.get('generation'));
    if (!args || args.positionals.length > 0 || executor === undefined || generation === null) {
        return wrongArguments(OWNER_USAGE);
    }
    const result = await handlers()['transfer-installation-scenario-owner'](
        null,
        executor as (typeof EXECUTORS)[number],
        generation,
    );
    if (!result.success) return lifecycleFailure(result, 'hand over the installation scenario');
    ui().success(`The installation scenario is now run by ${executor} (generation ${result.generation}).`);
    return 0;
};

/** `scenario-pause` and `scenario-resume`: one subject, a challenge id or `installation`. */
const pauseOrResume =
    (paused: boolean) =>
    async (argv: string[]): Promise<number> => {
        const usage = `Usage: scenario-${paused ? 'pause' : 'resume'} <challenge id|installation>`;
        const args = lifecycleArgs(argv);
        if (!args || args.positionals.length !== 1) return wrongArguments(usage);
        const subject = subjectOf(args.positionals[0]);
        const result = paused
            ? await handlers()['pause-scenario'](null, subject)
            : await handlers()['resume-scenario'](null, subject);
        if (!result.success) return lifecycleFailure(result, paused ? 'pause the scenario' : 'resume the scenario');
        ui().success(`${paused ? 'Paused' : 'Resumed'} the scenario of ${subjectName(subject)}.`);
        return 0;
    };

const scenarioPauseCommand = pauseOrResume(true);
const scenarioResumeCommand = pauseOrResume(false);

const HANDOFF_USAGE = 'Usage: scenario-handoff <challenge id|installation> "<scenario>"|--clear --generation=<n>';

/** `scenario-handoff`: gives a subject another scenario, or none, under the generation the user saw. */
const scenarioHandoffCommand = async (argv: string[]): Promise<number> => {
    const args = lifecycleArgs(argv, ['generation'], ['clear']);
    const generation = wholeNumber(args?.values.get('generation'));
    const clear = args?.switches.has('clear') === true;
    if (!args || generation === null || args.positionals.length !== (clear ? 1 : 2))
        return wrongArguments(HANDOFF_USAGE);
    const subject = subjectOf(args.positionals[0]);
    if (clear) {
        const cleared = await handlers()['clear-scenario-assignment'](null, subject, generation);
        if (!cleared.success) return lifecycleFailure(cleared, 'hand over the scenario');
        ui().success(`${capitalised(subjectName(subject))} has no scenario now.`);
        return 0;
    }
    const name = args.positionals[1];
    const result = await handlers()['handoff-scenario'](null, subject, name, generation);
    if (!result.success) return lifecycleFailure(result, 'hand over the scenario');
    ui().success(`${capitalised(subjectName(subject))} now follows "${stripTerminalControl(name)}".`);
    return 0;
};

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const POOL_USAGE =
    'Usage: photo-pool list  |  photo-pool save "<name>" <photo id>...  |  photo-pool delete "<name>"  |  photo-pool rename "<name>" "<new name>"';

/** `photo-pool`: the account's named photo pools. */
const photoPoolCommand = async (argv: string[]): Promise<number> => {
    const args = lifecycleArgs(argv);
    const [action, ...rest] = args?.positionals ?? [];
    if (!args || (action === 'list' && rest.length > 0)) return wrongArguments(POOL_USAGE);
    if (action === 'list') {
        const listed = await handlers()['get-photo-pools'](null);
        if (!listed.success) return reportFailure(listed, 'Could not list the photo pools');
        const names = Object.keys(listed.pools);
        ui().info(names.length ? `Photo pools (${names.length}):` : 'No photo pools yet.');
        for (const name of names)
            ui().info(`  • ${stripTerminalControl(name)} — ${listed.pools[name].length} photo(s)`);
        return 0;
    }
    if (action === 'save' && rest.length >= 2) {
        const [name, ...ids] = rest;
        const saved = await handlers()['set-photo-pool'](null, name, ids);
        if (!saved.success) return lifecycleFailure(saved, 'save the pool');
        ui().success(`Saved the pool "${stripTerminalControl(name)}" (${ids.length} photo(s)).`);
        return 0;
    }
    if (action === 'delete' && rest.length === 1) {
        const deleted = await handlers()['delete-photo-pool'](null, rest[0]);
        if (!deleted.success) return lifecycleFailure(deleted, 'delete the pool');
        ui().success(`Deleted the pool "${stripTerminalControl(rest[0])}".`);
        return 0;
    }
    if (action === 'rename' && rest.length === 2) {
        const renamed = await handlers()['rename-photo-pool'](null, rest[0], rest[1]);
        if (!renamed.success) return lifecycleFailure(renamed, 'rename the pool');
        ui().success(`Renamed the pool "${stripTerminalControl(rest[0])}" to "${stripTerminalControl(rest[1])}".`);
        return 0;
    }
    return wrongArguments(POOL_USAGE);
};

/** A typed value as one word of text: its plain value (a list as its items). */
const shown = (state: ValueState<ExprValue>): string => {
    if (state.state !== 'known') return `(${state.state})`;
    const { value } = state.value;
    return stripTerminalControl(Array.isArray(value) ? value.join(', ') : String(value));
};

/** `scenario-snapshot`: where a subject's scenario stands, in a few plain lines. */
const scenarioSnapshotCommand = async (argv: string[]): Promise<number> => {
    const args = lifecycleArgs(argv);
    if (!args || args.positionals.length !== 1)
        return wrongArguments('Usage: scenario-snapshot <challenge id|installation>');
    const result = await handlers()['get-scenario-snapshot'](null, subjectOf(args.positionals[0]));
    if (!result.success) return reportFailure(result, 'Could not read the scenario snapshot');
    const { assignment } = result;
    const owner = assignment !== null && typeof assignment === 'object' ? `, run by ${assignment.executor}` : '';
    const name = assignment !== null && typeof assignment === 'object' ? assignment.scenario : assignment;
    const generation = result.generation === null ? 'unknown' : String(result.generation);
    ui().info(
        `${capitalised(subjectName(result.subject))}: ${name ? `scenario "${stripTerminalControl(name)}"${owner}` : 'no scenario'}, generation ${generation}.`,
    );
    if (result.corrupt) ui().warning('The saved progress cannot be read.');
    ui().info(
        result.paused
            ? `Paused since ${at(result.paused.at)}${result.paused.reason ? `: ${stripTerminalControl(result.paused.reason)}` : ''}.`
            : 'Not paused.',
    );
    if (result.withdrawn)
        ui().info('A full Stop withdrew its settings: they apply again only after you start it again.');
    if (result.publication) ui().info(`Settings published (revision ${result.publication.revision}).`);
    const differing = Object.keys(result.effective).filter((key) => {
        const effective = result.effective[key];
        const saved = result.base[key];
        return (
            effective.state !== 'known' ||
            saved?.state !== 'known' ||
            JSON.stringify(saved.value) !== JSON.stringify(effective.value)
        );
    });
    for (const key of differing) {
        const effective = result.effective[key];
        ui().info(
            effective.state === 'known'
                ? `  ${key}: ${shown(result.base[key] ?? { state: 'absent' })} → ${shown(effective)}`
                : `  ${key}: not available (${effective.state === 'unknown' ? stripTerminalControl(effective.reason) : effective.reason})`,
        );
    }
    if (result.pins) {
        ui().info(`Boost pin: ${result.pins.effective.boost ?? 'none'}`);
        ui().info(`Turbo pin: ${result.pins.effective.turbo ?? 'none'}`);
    }
    if (result.pool)
        ui().info(`Photo pool "${stripTerminalControl(result.pool.name)}": ${result.pool.ids.length} photo(s)`);
    return 0;
};

/** `stop-status`: the priority Stop fence, whether the last Stop is saved for every runtime, and whether the owner acknowledged it. */
const stopStatusCommand = async (argv: string[]): Promise<number> => {
    if (argv.length > 0) return wrongArguments('Usage: stop-status');
    const result = await handlers()['get-stop-status'](null);
    if (!result.success) return reportFailure(result, 'Could not read the Stop status');
    const { fence } = result;
    if (fence.state === 'missing') {
        ui().info('Stop fence: not created yet.');
        return 0;
    }
    if (fence.state === 'unreadable') {
        ui().error(`The Stop fence cannot be read (${fence.reason}): nothing can be started until it can.`);
        return 1;
    }
    ui().info(`Stop fence: epoch ${fence.stopEpoch}, ${fence.blocked ? 'blocked' : 'open'}.`);
    if (!fence.lastStop) {
        ui().info('No Stop has been recorded.');
    } else {
        ui().info(
            `Last Stop: ${at(fence.lastStop.at)}, ${result.durable ? 'saved for every runtime and for a restart' : 'only this runtime stopped — the Stop could not be saved'}.`,
        );
    }
    if (result.ownerAcknowledged === null)
        ui().info('It is not known whether the installation owner has acknowledged it.');
    else
        ui().info(
            `The installation owner ${result.ownerAcknowledged ? 'has acknowledged it' : 'has not acknowledged it yet'}.`,
        );
    return 0;
};

const scenarioVocabulary = async () => {
    for (const [kind, type, fields] of VOCABULARY_REFERENCE)
        ui().info(`  ${kind.padEnd(9)} ${type.padEnd(16)} ${fields}`);
    return 0;
};

export {
    listScenarios,
    scenarioTemplate,
    importScenarioCmd,
    exportScenarioCmd,
    renameScenarioCmd,
    deleteScenarioCmd,
    scenarioStatusCmd,
    scenarioResetCmd,
    scenarioResetAllCmd,
    scenarioDryRunCmd,
    scenarioSimulateCommand,
    scenarioInstallationCommand,
    scenarioOwnerTransferCommand,
    scenarioPauseCommand,
    scenarioResumeCommand,
    scenarioHandoffCommand,
    photoPoolCommand,
    scenarioSnapshotCommand,
    stopStatusCommand,
    parseSimulateArgs,
    isoToSeconds,
    scenarioVocabulary,
};
