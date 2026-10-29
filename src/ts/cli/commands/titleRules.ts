/**
 * CLI title-rule commands — the parity of the GUI's Rules editor. Thin shells
 * over the settings facade only (the pattern of commands/settings/*): listing,
 * a JSON export/import with the same preview-and---yes gate the scenario
 * import has, and the rule-aware profile read for one challenge. The listings
 * carry user-authored rule text and settings values, so they print to the
 * console only (never into the log files), like every other settings listing.
 */

import * as fs from 'node:fs';
import * as logger from '../../logger';
import { escapeTerminalUnsafe, stripTerminalControl } from '../../format/logSafe';
import { formatSettingForLog } from './settings/shared';
import { resolveChallenge } from '../guards';
import { errorMessage } from '../../errorMessage';
import * as settings from '../../settings';

import type { ChallengeValues, RuleSource, TitleRule, TitleRuleInfo } from '../../types/settings';

const settingsLog = () => logger.withCategory('settings');

// The word for a title match mode, as the condition line reads it. A mode that
// is none of these (a hand-edited store) reads as a plain "title matches".
const MODE_WORDS: Record<string, string> = {
    exact: 'title is',
    contains: 'title contains',
    starts: 'title starts with',
};

const modeWord = (mode: string): string => (Object.hasOwn(MODE_WORDS, mode) ? MODE_WORDS[mode] : 'title matches');

const ruleTitles = (rule: TitleRule): string[] => {
    if (Array.isArray(rule.titles) && rule.titles.length > 0) return rule.titles;
    return typeof rule.title === 'string' && rule.title !== '' ? [rule.title] : [];
};

/**
 * One rule's match condition in words: its titles with their modes, then the
 * class conditions it lists (tag, type, photo count, runtime, close times).
 */
const describeConditions = (rule: TitleRule): string => {
    const titles = ruleTitles(rule);
    const modes =
        Array.isArray(rule.titleMatchModes) && rule.titleMatchModes.length === titles.length
            ? rule.titleMatchModes
            : titles.map(() => (typeof rule.match === 'string' ? rule.match : 'exact'));
    const parts = titles.map((title, i) => `${modeWord(modes[i])} "${stripTerminalControl(title)}"`);
    if (typeof rule.challengeTag === 'string' && rule.challengeTag !== '')
        parts.push(`tag "${stripTerminalControl(rule.challengeTag)}"`);
    if (typeof rule.type === 'string' && rule.type !== '') parts.push(`type ${stripTerminalControl(rule.type)}`);
    if (typeof rule.pics === 'number') parts.push(`${rule.pics} pics`);
    if (typeof rule.minHours === 'number' || typeof rule.maxHours === 'number') {
        const from = typeof rule.minHours === 'number' ? `${rule.minHours}h` : '0h';
        const to = typeof rule.maxHours === 'number' ? `${rule.maxHours}h` : '…';
        parts.push(`runs ${from}–${to}`);
    }
    if (typeof rule.closesAt === 'string' && rule.closesAt !== '') {
        const more =
            Array.isArray(rule.closesAtTimes) && rule.closesAtTimes.length > 1
                ? ` (+${rule.closesAtTimes.length - 1} more)`
                : '';
        parts.push(`closes ${stripTerminalControl(rule.closesAt)}${more}`);
    }
    return parts.length > 0 ? parts.join(', ') : 'no condition';
};

/**
 * One rule's behaviour in words: its tag lists, the profile it inherits and
 * the settings it overrides inline (values masked like every settings print).
 */
const describeBehaviour = (rule: TitleRule): string[] => {
    const does: string[] = [];
    if (Array.isArray(rule.mustIncludeTags) && rule.mustIncludeTags.length > 0)
        does.push(`must include ${rule.mustIncludeTags.map((tag) => stripTerminalControl(tag)).join(', ')}`);
    if (Array.isArray(rule.shouldIncludeTags) && rule.shouldIncludeTags.length > 0)
        does.push(`should include ${rule.shouldIncludeTags.map((tag) => stripTerminalControl(tag)).join(', ')}`);
    if (typeof rule.profile === 'string' && rule.profile !== '')
        does.push(`profile "${stripTerminalControl(rule.profile)}"`);
    for (const key of settings.TITLE_RULE_INLINE_KEYS) {
        if (Object.hasOwn(rule, key)) does.push(`${key}: ${formatSettingForLog(key, rule[key])}`);
    }
    return does;
};

const ruleBlockLines = (rules: readonly TitleRule[]): string[] => {
    const lines: string[] = [];
    rules.forEach((rule, index) => {
        lines.push(`${index + 1}. ${describeConditions(rule)}`);
        for (const line of describeBehaviour(rule)) lines.push(`   ${line}`);
    });
    return lines;
};

/**
 * The stored rules, one block per rule: what it matches and what it does.
 */
const listTitleRulesCmd = (): void => {
    const rules = settings.getTitleRules();
    if (rules.length === 0) {
        settingsLog().info(
            'No title rules stored. To create some, edit one into a file and run: import-title-rules <file> --yes',
        );
        return;
    }
    settingsLog().info(`${rules.length} title rule(s) stored, in precedence order:`);
    for (const line of ruleBlockLines(rules)) logger.printLine(line);
};

/**
 * The rules as JSON — printed on the console when no file is given, written to
 * `file` otherwise. The write is an exclusive create unless --overwrite: an
 * existing file is refused, never silently replaced. Returns the exit code.
 */
const exportTitleRulesCmd = (file: string | undefined, overwrite: boolean): number => {
    const json = `${JSON.stringify(settings.getTitleRules(), null, 2)}\n`;
    if (!file) {
        // A document the user asked to see (or pipe): printed verbatim, with its
        // line breaks, on the console only — it holds the account's photo ids.
        logger.printDocument(escapeTerminalUnsafe(json).replace(/\n$/, ''));
        return 0;
    }
    try {
        fs.writeFileSync(file, escapeTerminalUnsafe(json), { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
        settingsLog().success(`Written to ${file}`);
        return 0;
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
            settingsLog().error(`${file} already exists — add --overwrite to replace it`);
        } else {
            settingsLog().error(`Could not write ${file}: ${errorMessage(error)}`);
        }
        return 1;
    }
};

/**
 * The JSON text of an import file as `unknown`, or `{ ok: false }` (said
 * loudly) when the file cannot be read or parsed — an unreadable file is never
 * merged. A parsed JSON `null` is a value like any other: the caller hands it
 * to the preview, which rejects it with its own reason.
 */
const readRulesFile = (file: string): { ok: true; value: unknown } | { ok: false } => {
    try {
        return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) as unknown };
    } catch (error) {
        settingsLog().error(`Could not read ${file} as JSON: ${errorMessage(error)}`);
        return { ok: false };
    }
};

// A note the sanitizer produced, printed with its 1-based input place and a
// stripped label: the rule text is user-authored and must not drive the terminal.
const printNotes = (kind: string, notes: readonly settings.TitleRuleNote[]): void => {
    for (const note of notes)
        logger.printLine(
            `${kind} rule ${note.index} (${stripTerminalControl(note.label)}): ${stripTerminalControl(note.reason)}`,
        );
};

/**
 * Import a rules file. The file is read as `unknown` and run through the same
 * dry-run the write performs, so the preview cannot drift from what --yes
 * stores: without --yes it prints what would replace the current rules and
 * changes nothing; with --yes it writes. A malformed file (unreadable or
 * unparseable) is rejected loudly and exits 1 — it is never merged.
 * Returns the exit code.
 */
const importTitleRulesCmd = (file: string, yes: boolean): number => {
    const read = readRulesFile(file);
    if (!read.ok) return 1;
    const preview = settings.previewTitleRules(read.value);
    if (!preview.ok) {
        settingsLog().error(`The rules in ${file} would be rejected: ${preview.error}`);
        return 1;
    }
    const current = settings.getTitleRules().length;
    if (!yes) {
        settingsLog().info(`This replaces your ${current} current rule(s) with ${preview.rules.length}:`);
        for (const line of ruleBlockLines(preview.rules)) logger.printLine(line);
        printNotes('Dropped', preview.dropped);
        printNotes('Collapsed', preview.collapsed);
        settingsLog().info(`Nothing imported yet. To import, re-run: import-title-rules ${file} --yes`);
        return 0;
    }
    if (!settings.setTitleRules(read.value)) {
        settingsLog().error(
            'The import was rejected — the reason is in the log (logs --settings shows it). The stored rules are unchanged.',
        );
        return 1;
    }
    settingsLog().success(`Imported ${preview.rules.length} title rule(s), replacing ${current}`);
    return 0;
};

// The label of the rule a value comes from: its list place, its title when it
// has one, and whether the value rides the rule's profile.
const sourceLabel = (source: RuleSource): string =>
    `rule #${source.index}${typeof source.title === 'string' && source.title !== '' ? ` "${stripTerminalControl(source.title)}"` : ''}${source.viaProfile ? ' (via its profile)' : ''}`;

// The distinct rules a profile read names, in list order.
const appliedRules = (info: TitleRuleInfo): RuleSource[] => {
    const byIndex = new Map<number, RuleSource>();
    for (const source of [...Object.values(info.ruleSources), ...Object.values(info.inlineSources)]) {
        if (!byIndex.has(source.index)) byIndex.set(source.index, source);
    }
    return [...byIndex.values()].sort((a, b) => a.index - b.index);
};

// One values layer: each key with its masked value and the rule it comes from.
// Every value has a source: the read model sets the two maps together.
const printValues = (values: ChallengeValues, sources: Record<string, RuleSource>): void => {
    for (const [key, value] of Object.entries(values)) {
        logger.printLine(`  ${key}: ${formatSettingForLog(key, value)} — from ${sourceLabel(sources[key])}`);
    }
};

/**
 * Which rule or profile applies to one challenge, and the settings they set —
 * the CLI parity of the card's rule strip. Resolves the challenge from the
 * active list first, so an unknown id fails the command. Returns false on
 * that miss (exit 1).
 */
const titleProfileCmd = async (challengeId: string): Promise<boolean> => {
    const challenge = await resolveChallenge(challengeId);
    if (!challenge) return false;
    const info = settings.getTitleProfile(challenge, challenge.id);
    const rules = appliedRules(info);
    logger.printLine(
        `Challenge ${stripTerminalControl(String(challenge.id))} "${stripTerminalControl(challenge.title)}"`,
    );
    if (rules.length === 0) {
        logger.printLine('No rule matches this challenge.');
        return true;
    }
    logger.printLine(`Matching rules: ${rules.map(sourceLabel).join(', ')}`);
    if (info.profile) {
        logger.printLine(`Profile from the rules: "${stripTerminalControl(info.profile.name)}"`);
        if (info.suppressed)
            logger.printLine('  Suppressed — a manually applied profile stands in for it on this challenge.');
    }
    // Matching rules always contribute a value (their sources are what named
    // them here); the inline layer is present only when a rule sets one.
    logger.printLine('  Rule values:');
    printValues(info.ruleValues, info.ruleSources);
    if (Object.keys(info.inlineValues).length > 0) {
        logger.printLine('  Inline values (still applied when the profile is suppressed):');
        printValues(info.inlineValues, info.inlineSources);
    }
    return true;
};

export { listTitleRulesCmd, exportTitleRulesCmd, importTitleRulesCmd, titleProfileCmd };
