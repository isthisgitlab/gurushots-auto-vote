/**
 * Unit tests for the CLI title-rule commands (commands/titleRules.ts) and
 * their strict handlers: listing, JSON export (exclusive create unless
 * --overwrite), the import preview + --yes gate over the facade's dry-run,
 * and the per-challenge profile read. The settings facade, the filesystem and
 * the middleware are mocked; the settings commands' strict parsing is asserted
 * through the commandHandlers run* handlers, usage errors included.
 */

jest.mock('../../src/ts/logger', () => {
    const calls: { level: string; msg: unknown }[] = [];
    const rec = (level: string) => (msg: unknown) => calls.push({ level, msg: String(msg) });
    const cat = {
        info: rec('info'),
        error: rec('error'),
        success: rec('success'),
        warning: rec('warning'),
        debug: rec('debug'),
    };
    return {
        __calls: calls,
        withCategory: jest.fn(() => cat),
        printLine: rec('stdout'),
        printDocument: rec('stdout'),
        printStderr: rec('stderr'),
    };
});

jest.mock('../../src/ts/settings', () => ({
    // Tests replace entries on this object; the marker makes it the very
    // namespace the command modules import rather than a copy.
    __esModule: true,
    SETTINGS_SCHEMA: { exposure: { type: 'number', perChallenge: true, default: 50 } },
    TITLE_RULE_INLINE_KEYS: ['autoJoin', 'chosenPhotos', 'scenario'],
    isPinnableImageId: jest.fn(() => false),
    getTitleRules: jest.fn(() => []),
    setTitleRules: jest.fn(),
    previewTitleRules: jest.fn(),
    getTitleProfile: jest.fn(),
    getGlobalDefault: jest.fn(),
    isGlobalDefaultModified: jest.fn(() => false),
    resetGlobalDefault: jest.fn(),
    resetAllGlobalDefaults: jest.fn(),
}));

jest.mock('../../src/ts/apiFactory', () => {
    const mw = {
        isAuthenticated: jest.fn(() => true),
        getActiveChallenges: jest.fn(),
        applyBoost: jest.fn(),
    };
    return { __mw: mw, getMiddleware: jest.fn(() => mw) };
});

jest.mock('node:fs', () => ({ readFileSync: jest.fn(), writeFileSync: jest.fn() }));

import { invalid } from '../helpers/invalid';
import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(invalid<typeof loggerModule & { __calls: { level: string; msg: unknown }[] }>(loggerModule));
import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import type * as apiFactoryModule from '../../src/ts/apiFactory';
const { __mw: mw } = jest.mocked(
    require('../../src/ts/apiFactory') as typeof apiFactoryModule & {
        __mw: jest.Mocked<
            Pick<ReturnType<typeof apiFactoryModule.getMiddleware>, 'isAuthenticated' | 'getActiveChallenges'>
        >;
    },
);
import type * as titleRuleHandlersModule from '../../src/ts/cli/titleRuleHandlers';
import type * as settingsHandlersModule from '../../src/ts/cli/settingsHandlers';
import type * as titleRulesCommandsModule from '../../src/ts/cli/commands/titleRules';
// The rows↔handlers cycle initialises only rows-first (commandRows reads the handlers'
// exports at module scope), so load the rows before reaching for their handlers.
require('../../src/ts/cli/commandRows');
const titleRuleHandlers = require('../../src/ts/cli/titleRuleHandlers') as typeof titleRuleHandlersModule;
const settingsHandlers = require('../../src/ts/cli/settingsHandlers') as typeof settingsHandlersModule;
const cmd = require('../../src/ts/cli/commands/titleRules') as typeof titleRulesCommandsModule;

const msgs = (level: string) => logger.__calls.filter((c) => c.level === level).map((c) => String(c.msg));
const stdout = () => msgs('stdout');
const contains = (arr: string[], sub: string) => arr.some((s) => s.includes(sub));

const RULE: Record<string, unknown> = {
    title: 'Seaside',
    mustIncludeTags: ['sea'],
    shouldIncludeTags: ['sunset'],
    profile: 'Tactic',
    autoJoin: true,
    challengeTag: 'nature',
    type: 'default',
    pics: 4,
    minHours: 2,
    maxHours: 12,
    closesAt: '18:00',
};

beforeEach(() => {
    logger.__calls.length = 0;
    jest.clearAllMocks();
    settings.getTitleRules.mockReturnValue([]);
    mw.isAuthenticated.mockReturnValue(true);
    mw.getActiveChallenges.mockResolvedValue(invalid({ challenges: [{ id: 111, title: 'Sunset' }] }));
});

describe('list-title-rules', () => {
    test('no rules prints the how-to line', () => {
        cmd.listTitleRulesCmd();
        expect(msgs('info')).toEqual([expect.stringContaining('No title rules stored')]);
        expect(stdout()).toEqual([]);
    });

    test('one block per rule: its condition, then what it does', () => {
        settings.getTitleRules.mockReturnValue(invalid([RULE, { title: 'Pets', mustIncludeTags: ['cat'] }]));
        cmd.listTitleRulesCmd();
        expect(msgs('info')).toEqual(['2 title rule(s) stored, in precedence order:']);
        const lines = stdout();
        expect(lines[0]).toBe('1. title is "Seaside", tag "nature", type default, 4 pics, runs 2h–12h, closes 18:00');
        expect(contains(lines, 'must include sea')).toBe(true);
        expect(contains(lines, 'should include sunset')).toBe(true);
        expect(contains(lines, 'profile "Tactic"')).toBe(true);
        expect(contains(lines, 'autoJoin: true')).toBe(true);
        expect(lines).toContain('2. title is "Pets"');
    });

    test('every match mode is worded, and a hand-edited one reads as a plain match', () => {
        settings.getTitleRules.mockReturnValue(
            invalid([
                { titles: ['A', 'B'], titleMatchModes: ['contains', 'starts'] },
                { title: 'C', match: 'weird' },
                { challengeTag: 'only-tag' },
            ]),
        );
        cmd.listTitleRulesCmd();
        const lines = stdout();
        expect(contains(lines, 'title contains "A", title starts with "B"')).toBe(true);
        expect(contains(lines, 'title matches "C"')).toBe(true);
        expect(contains(lines, 'tag "only-tag"')).toBe(true);
    });

    test('half-open runtime ranges, several close times, and a condition-less row read sensibly', () => {
        settings.getTitleRules.mockReturnValue(
            invalid([
                { title: 'Half', minHours: 2 },
                { title: 'Wide', maxHours: 12 },
                { title: 'Times', closesAt: '18:00', closesAtTimes: ['18:00', '21:00'] },
                { mustIncludeTags: ['x'] },
            ]),
        );
        cmd.listTitleRulesCmd();
        const lines = stdout();
        expect(contains(lines, 'runs 2h–…')).toBe(true);
        expect(contains(lines, 'runs 0h–12h')).toBe(true);
        expect(contains(lines, 'closes 18:00 (+1 more)')).toBe(true);
        expect(contains(lines, 'no condition')).toBe(true);
    });

    test('control characters in stored rule text never reach the terminal', () => {
        settings.getTitleRules.mockReturnValue(
            invalid([{ title: 'a\u001b[31mb', mustIncludeTags: ['x‮y'], profile: 'p\u0085q', autoJoin: true }]),
        );
        cmd.listTitleRulesCmd();
        const printed = stdout().join('\n');
        // The join's own line breaks stay; no stored control character does.
        expect(printed).not.toMatch(/(?!\n)[\p{Cc}\p{Cf}]/u);
        expect(contains(stdout(), 'title is "ab"')).toBe(true);
    });
});

describe('export-title-rules', () => {
    test('without a file the JSON is printed as a document', () => {
        settings.getTitleRules.mockReturnValue(invalid([{ title: 'Seaside', mustIncludeTags: ['sea'] }]));
        expect(cmd.exportTitleRulesCmd(undefined, false)).toBe(0);
        const [doc] = stdout();
        expect(doc).toContain('"title": "Seaside"');
    });

    test('with a file it is an exclusive create', () => {
        expect(cmd.exportTitleRulesCmd('rules.json', false)).toBe(0);
        expect(fs.writeFileSync).toHaveBeenCalledWith('rules.json', expect.any(String), {
            encoding: 'utf8',
            flag: 'wx',
        });
        expect(contains(msgs('success'), 'Written to rules.json')).toBe(true);
    });

    test('an existing file is refused without --overwrite, and exits 1', () => {
        fs.writeFileSync.mockImplementationOnce(() => {
            throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
        });
        expect(cmd.exportTitleRulesCmd('rules.json', false)).toBe(1);
        expect(contains(msgs('error'), 'rules.json already exists — add --overwrite to replace it')).toBe(true);
    });

    test('--overwrite replaces the file', () => {
        expect(cmd.exportTitleRulesCmd('rules.json', true)).toBe(0);
        expect(fs.writeFileSync).toHaveBeenCalledWith('rules.json', expect.any(String), {
            encoding: 'utf8',
            flag: 'w',
        });
    });

    test('a failed write is reported and exits 1', () => {
        fs.writeFileSync.mockImplementationOnce(() => {
            throw new Error('disk full');
        });
        expect(cmd.exportTitleRulesCmd('rules.json', false)).toBe(1);
        expect(contains(msgs('error'), 'Could not write rules.json: disk full')).toBe(true);
    });
});

describe('import-title-rules', () => {
    const PREVIEW = {
        ok: true as const,
        rules: [{ title: 'A', mustIncludeTags: ['x'], shouldIncludeTags: [] }],
        dropped: [{ index: 2, label: 'Noop', reason: 'the rule matches but sets nothing' }],
        collapsed: [],
    };

    test('a file that cannot be read is rejected loudly and exits 1', () => {
        fs.readFileSync.mockImplementationOnce(() => {
            throw new Error('EACCES: permission denied');
        });
        expect(cmd.importTitleRulesCmd('rules.json', false)).toBe(1);
        expect(contains(msgs('error'), 'Could not read rules.json as JSON: EACCES')).toBe(true);
        expect(settings.setTitleRules).not.toHaveBeenCalled();
    });

    test('a file that cannot be parsed is rejected loudly and exits 1', () => {
        fs.readFileSync.mockReturnValue('not json');
        expect(cmd.importTitleRulesCmd('rules.json', false)).toBe(1);
        expect(contains(msgs('error'), 'Could not read rules.json as JSON:')).toBe(true);
        expect(settings.setTitleRules).not.toHaveBeenCalled();
    });

    test('a list the write would reject exits 1 before anything is stored', () => {
        fs.readFileSync.mockReturnValue('[]');
        settings.previewTitleRules.mockReturnValue({ ok: false, error: 'setTitleRules expects an array' });
        expect(cmd.importTitleRulesCmd('rules.json', true)).toBe(1);
        expect(contains(msgs('error'), 'would be rejected: setTitleRules expects an array')).toBe(true);
        expect(settings.setTitleRules).not.toHaveBeenCalled();
    });

    test('without --yes it previews: what it replaces, what would be stored, what is dropped', () => {
        fs.readFileSync.mockReturnValue('[{"title":"A","mustIncludeTags":["x"]}]');
        settings.getTitleRules.mockReturnValue(invalid([{ title: 'Old', mustIncludeTags: [] }]));
        settings.previewTitleRules.mockReturnValue(PREVIEW);
        expect(cmd.importTitleRulesCmd('rules.json', false)).toBe(0);
        expect(contains(msgs('info'), 'This replaces your 1 current rule(s) with 1')).toBe(true);
        expect(stdout()).toContain('1. title is "A"');
        expect(stdout()).toContain('Dropped rule 2 (Noop): the rule matches but sets nothing');
        expect(
            contains(msgs('info'), 'Nothing imported yet. To import, re-run: import-title-rules rules.json --yes'),
        ).toBe(true);
        expect(settings.setTitleRules).not.toHaveBeenCalled();
    });

    test('a collapsed rule is said with the rule it merges into', () => {
        fs.readFileSync.mockReturnValue('[]');
        settings.previewTitleRules.mockReturnValue(
            invalid({
                ...PREVIEW,
                dropped: [],
                collapsed: [
                    {
                        index: 2,
                        label: 'A',
                        reason: 'same match condition as rule 1 ("A") — the later values win, at the first one\'s position',
                    },
                ],
            }),
        );
        expect(cmd.importTitleRulesCmd('rules.json', false)).toBe(0);
        expect(stdout()).toContain(
            'Collapsed rule 2 (A): same match condition as rule 1 ("A") — the later values win, at the first one\'s position',
        );
    });

    test('a note label carrying control characters is stripped before printing', () => {
        fs.readFileSync.mockReturnValue('[]');
        settings.previewTitleRules.mockReturnValue(
            invalid({ ...PREVIEW, dropped: [{ index: 2, label: 'a\u001b[31mb', reason: 'r' }] }),
        );
        cmd.importTitleRulesCmd('rules.json', false);
        expect(stdout()).toContain('Dropped rule 2 (ab): r');
        expect(stdout().join('\n')).not.toMatch(/(?!\n)[\p{Cc}\p{Cf}]/u);
    });

    test('--yes stores the parsed file and confirms', () => {
        const input = [{ title: 'A', mustIncludeTags: ['x'] }];
        fs.readFileSync.mockReturnValue(JSON.stringify(input));
        settings.previewTitleRules.mockReturnValue(PREVIEW);
        settings.getTitleRules.mockReturnValue(invalid([{ title: 'Old', mustIncludeTags: [] }]));
        settings.setTitleRules.mockReturnValue(true);
        expect(cmd.importTitleRulesCmd('rules.json', true)).toBe(0);
        expect(settings.setTitleRules).toHaveBeenCalledWith(input);
        expect(contains(msgs('success'), 'Imported 1 title rule(s), replacing 1')).toBe(true);
    });

    test('a false setTitleRules exits 1 and points to the logged reason', () => {
        fs.readFileSync.mockReturnValue('[]');
        settings.previewTitleRules.mockReturnValue(PREVIEW);
        settings.setTitleRules.mockReturnValue(false);
        expect(cmd.importTitleRulesCmd('rules.json', true)).toBe(1);
        expect(contains(msgs('error'), 'The import was rejected — the reason is in the log')).toBe(true);
        expect(msgs('success')).toEqual([]);
    });
});

describe('title-profile', () => {
    test('an unknown challenge id fails without reading the profile', async () => {
        mw.getActiveChallenges.mockResolvedValue(invalid({ challenges: [] }));
        await expect(cmd.titleProfileCmd('999')).resolves.toBe(false);
        expect(settings.getTitleProfile).not.toHaveBeenCalled();
        expect(contains(msgs('error'), 'not found among active challenges')).toBe(true);
    });

    test('a failed fetch fails the command', async () => {
        mw.getActiveChallenges.mockRejectedValue(new Error('offline'));
        await expect(cmd.titleProfileCmd('111')).resolves.toBe(false);
        expect(contains(msgs('error'), 'Failed to fetch challenges')).toBe(true);
    });

    test('no matching rule says so', async () => {
        settings.getTitleProfile.mockReturnValue(
            invalid({
                profile: null,
                suppressed: false,
                ruleValues: {},
                inlineValues: {},
                ruleSources: {},
                inlineSources: {},
            }),
        );
        await expect(cmd.titleProfileCmd('111')).resolves.toBe(true);
        expect(settings.getTitleProfile).toHaveBeenCalledWith(expect.objectContaining({ id: 111 }), 111);
        expect(stdout()).toContain('No rule matches this challenge.');
    });

    test('the matching rules, the profile, its suppression and their values are printed', async () => {
        settings.getTitleProfile.mockReturnValue(
            invalid({
                profile: { name: 'Tactic', values: { exposure: 80 } },
                suppressed: true,
                ruleValues: { exposure: 80, autoJoin: true },
                inlineValues: { autoJoin: true },
                ruleSources: { exposure: { index: 1, title: 'Seaside', viaProfile: true }, autoJoin: { index: 2 } },
                inlineSources: { autoJoin: { index: 2 } },
            }),
        );
        await expect(cmd.titleProfileCmd('111')).resolves.toBe(true);
        const lines = stdout();
        expect(lines[0]).toBe('Challenge 111 "Sunset"');
        expect(lines[1]).toBe('Matching rules: rule #1 "Seaside" (via its profile), rule #2');
        expect(contains(lines, 'Profile from the rules: "Tactic"')).toBe(true);
        expect(contains(lines, 'Suppressed — a manually applied profile stands in for it')).toBe(true);
        expect(contains(lines, 'Rule values:')).toBe(true);
        expect(contains(lines, 'exposure: 80 — from rule #1 "Seaside" (via its profile)')).toBe(true);
        expect(contains(lines, 'Inline values (still applied when the profile is suppressed):')).toBe(true);
        expect(contains(lines, 'autoJoin: true — from rule #2')).toBe(true);
    });

    test('a matching rule without a profile says so, and skips the inline layer when none is set', async () => {
        settings.getTitleProfile.mockReturnValue(
            invalid({
                profile: null,
                suppressed: false,
                ruleValues: { exposure: 70 },
                inlineValues: {},
                ruleSources: { exposure: { index: 3 } },
                inlineSources: {},
            }),
        );
        await expect(cmd.titleProfileCmd('111')).resolves.toBe(true);
        const lines = stdout();
        expect(contains(lines, 'Matching rules: rule #3')).toBe(true);
        expect(lines.some((l) => l.includes('Profile from the rules'))).toBe(false);
        expect(lines.some((l) => l.includes('Suppressed'))).toBe(false);
        expect(contains(lines, 'exposure: 70 — from rule #3')).toBe(true);
        expect(lines.some((l) => l.includes('Inline values'))).toBe(false);
    });

    test('an unsuppressed profile prints without the suppression note', async () => {
        settings.getTitleProfile.mockReturnValue(
            invalid({
                profile: { name: 'Tactic', values: { exposure: 80 } },
                suppressed: false,
                ruleValues: { exposure: 80 },
                inlineValues: {},
                ruleSources: { exposure: { index: 1, title: 'Seaside', viaProfile: true } },
                inlineSources: {},
            }),
        );
        await expect(cmd.titleProfileCmd('111')).resolves.toBe(true);
        const lines = stdout();
        expect(contains(lines, 'Profile from the rules: "Tactic"')).toBe(true);
        expect(lines.some((l) => l.includes('Suppressed'))).toBe(false);
        expect(lines.some((l) => l.includes('Inline values'))).toBe(false);
    });

    test('a challenge title carrying control characters is stripped', async () => {
        mw.getActiveChallenges.mockResolvedValue(invalid({ challenges: [{ id: 111, title: 'a\u001b[31mb' }] }));
        settings.getTitleProfile.mockReturnValue(
            invalid({
                profile: null,
                suppressed: false,
                ruleValues: {},
                inlineValues: {},
                ruleSources: {},
                inlineSources: {},
            }),
        );
        await cmd.titleProfileCmd('111');
        expect(stdout()[0]).toBe('Challenge 111 "ab"');
    });
});

describe('strict parsing (titleRuleHandlers / settingsHandlers)', () => {
    test('list-title-rules takes no arguments', async () => {
        await expect(titleRuleHandlers.runListTitleRules(['--yes'])).resolves.toBe(1);
        expect(contains(msgs('error'), 'Wrong arguments')).toBe(true);
        expect(contains(msgs('info'), 'Usage: list-title-rules')).toBe(true);
        expect(settings.getTitleRules).not.toHaveBeenCalled();
    });

    test('a bare list-title-rules lists and exits 0', async () => {
        await expect(titleRuleHandlers.runListTitleRules([])).resolves.toBe(0);
        expect(settings.getTitleRules).toHaveBeenCalled();
    });

    test('export-title-rules forwards the file and --overwrite, and exits with the command', async () => {
        await expect(titleRuleHandlers.runExportTitleRules(['rules.json', '--overwrite'])).resolves.toBe(0);
        expect(fs.writeFileSync).toHaveBeenCalledWith('rules.json', expect.any(String), {
            encoding: 'utf8',
            flag: 'w',
        });
    });

    test('import-title-rules forwards the file and --yes, and exits with the command', async () => {
        fs.readFileSync.mockReturnValue('[]');
        settings.previewTitleRules.mockReturnValue(invalid({ ok: true, rules: [], dropped: [], collapsed: [] }));
        settings.getTitleRules.mockReturnValue([]);
        settings.setTitleRules.mockReturnValue(true);
        await expect(titleRuleHandlers.runImportTitleRules(['rules.json', '--yes'])).resolves.toBe(0);
        expect(settings.setTitleRules).toHaveBeenCalledWith([]);
    });

    test.each([
        ['a repeated --overwrite', ['a.json', 'b.json']],
        ['an unknown flag', ['a.json', '--yes']],
        ['a repeated flag', ['--overwrite', '--overwrite']],
    ])('export-title-rules: %s prints the usage and exits 1', async (_label, argv) => {
        await expect(titleRuleHandlers.runExportTitleRules(argv)).resolves.toBe(1);
        expect(contains(msgs('error'), 'Wrong arguments')).toBe(true);
        expect(contains(msgs('info'), 'Usage: export-title-rules [file] [--overwrite]')).toBe(true);
        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    test.each([
        ['a missing file', []],
        ['a second positional', ['a.json', 'b.json', '--yes']],
        ['an unknown flag', ['a.json', '--overwrite']],
        ['a repeated --yes', ['a.json', '--yes', '--yes']],
    ])('import-title-rules: %s prints the usage and exits 1', async (_label, argv) => {
        await expect(titleRuleHandlers.runImportTitleRules(argv)).resolves.toBe(1);
        expect(contains(msgs('error'), 'Wrong arguments')).toBe(true);
        expect(contains(msgs('info'), 'Usage: import-title-rules <file> [--yes]')).toBe(true);
        expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    test.each([
        ['a missing --challenge', [], 'Please specify a challenge id with --challenge'],
        ['a space-form flag', ['--challenge', '111'], 'Wrong arguments'],
        ['a bare flag', ['--challenge='], 'Wrong arguments'],
        ['a repeat', ['--challenge=111', '--challenge=222'], 'Wrong arguments'],
        ['an extra argument', ['--challenge=111', 'extra'], 'Wrong arguments'],
    ])('title-profile: %s prints the usage and exits 1', async (_label, argv, message) => {
        await expect(titleRuleHandlers.runTitleProfile(argv)).resolves.toBe(1);
        expect(contains(msgs('error'), message)).toBe(true);
        expect(contains(msgs('info'), 'Usage: title-profile --challenge=<id>')).toBe(true);
        expect(mw.getActiveChallenges).not.toHaveBeenCalled();
    });

    test('reset-global-default needs exactly one key', async () => {
        await expect(settingsHandlers.runResetGlobalDefault([])).resolves.toBe(1);
        await expect(settingsHandlers.runResetGlobalDefault(['a', 'b'])).resolves.toBe(1);
        expect(settings.resetGlobalDefault).not.toHaveBeenCalled();
        settings.resetGlobalDefault.mockReturnValue(true);
        await expect(settingsHandlers.runResetGlobalDefault(['exposure'])).resolves.toBe(0);
        expect(settings.resetGlobalDefault).toHaveBeenCalledWith('exposure');
        settings.resetGlobalDefault.mockReturnValue(false);
        await expect(settingsHandlers.runResetGlobalDefault(['exposure'])).resolves.toBe(1);
    });

    test('reset-all-global-defaults takes --yes alone', async () => {
        await expect(settingsHandlers.runResetAllGlobalDefaults(['--yes', 'extra'])).resolves.toBe(1);
        await expect(settingsHandlers.runResetAllGlobalDefaults(['--yes', '--yes'])).resolves.toBe(1);
        await expect(settingsHandlers.runResetAllGlobalDefaults(['--nope'])).resolves.toBe(1);
        expect(settings.resetAllGlobalDefaults).not.toHaveBeenCalled();
        settings.resetAllGlobalDefaults.mockReturnValue(true);
        await expect(settingsHandlers.runResetAllGlobalDefaults(['--yes'])).resolves.toBe(0);
        expect(settings.resetAllGlobalDefaults).toHaveBeenCalledWith();
        settings.resetAllGlobalDefaults.mockReturnValue(false);
        await expect(settingsHandlers.runResetAllGlobalDefaults(['--yes'])).resolves.toBe(1);
    });

    test('title-profile exits with the command result', async () => {
        settings.getTitleProfile.mockReturnValue(
            invalid({
                profile: null,
                suppressed: false,
                ruleValues: {},
                inlineValues: {},
                ruleSources: {},
                inlineSources: {},
            }),
        );
        await expect(titleRuleHandlers.runTitleProfile(['--challenge=111'])).resolves.toBe(0);
        mw.getActiveChallenges.mockResolvedValue(invalid({ challenges: [] }));
        await expect(titleRuleHandlers.runTitleProfile(['--challenge=999'])).resolves.toBe(1);
    });
});
