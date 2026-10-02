/**
 * Markup guard for the renderer components that share structure with a
 * sibling (language buttons, toggle rows, scenario field editors, hint text):
 * their `container.innerHTML` is pinned to tests/react/__data__/rendererMarkup.json,
 * so a refactor of how they are assembled cannot change what they render.
 * Set RECORD_MARKUP=1 to rewrite the data file after an intended markup change.
 */
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor } from './helpers/test-utils';
import type { ComponentChild } from 'preact';
import { LanguageSwitcher } from '@/components/login/LanguageSwitcher';
import { SettingsToggles } from '@/components/login/SettingsToggles';
import { ItemEditor } from '@/components/app/scenarioBuilder/ItemEditors';
import { challengeSettingHints, globalSettingHints, SettingHintList } from '@/components/app/SettingHints';
import { invalid } from '../helpers/invalid';
import type { Challenge } from '../../src/ts/types/gurushots';
import type { RendererSchema } from '../../src/ts/types/settingsEditor';

// tests/setup.ts stubs node:fs; the recorder needs the real one.
const { readFileSync, writeFileSync } = jest.requireActual<typeof import('node:fs')>('node:fs');
const DATA_FILE = join(__dirname, '__data__', 'rendererMarkup.json');
const PHASES = ['main', 'later'];
// Keeps the placeholders so the clock / offset substitutions show in the markup.
const translate = (key: string) => `${key} {0} {1} {2} {3}`;
const noop = () => undefined;

type Markup = Record<string, string>;
const recorded: Markup = {};

const editor = (kind: 'condition' | 'action' | 'selector', value: unknown) => (
    <ItemEditor kind={kind} value={value} onChange={noop} phases={PHASES} />
);

const CASES: Record<string, () => ComponentChild> = {
    languageSwitcher: () => <LanguageSwitcher />,
    settingsToggles: () => (
        <SettingsToggles
            theme="nord"
            stayLoggedIn
            mockMode={false}
            onThemeChange={noop}
            onStayLoggedInChange={noop}
            onMockModeChange={noop}
        />
    ),
    settingsTogglesOff: () => (
        <SettingsToggles
            theme="light"
            stayLoggedIn={false}
            mockMode
            onThemeChange={noop}
            onStayLoggedInChange={noop}
            onMockModeChange={noop}
        />
    ),
    conditionBalance: () => editor('condition', { type: 'balance', currency: 'swaps', op: '>=', value: 3 }),
    conditionDailyWindow: () => editor('condition', { type: 'dailyWindow', from: '06:00', to: '08:00' }),
    conditionBeforeEnd: () => editor('condition', { type: 'beforeEnd', min: '1h' }),
    conditionElapsed: () => editor('condition', { type: 'elapsedPercent', max: 50 }),
    conditionBoostState: () => editor('condition', { type: 'boostState', in: ['AVAILABLE'] }),
    conditionMemorySet: () => editor('condition', { type: 'memorySet', slot: 'held' }),
    conditionEntryNumber: () =>
        editor('condition', {
            type: 'entry',
            select: { by: 'bestRank' },
            field: 'votes',
            op: '>=',
            value: 5,
            window: '1h',
        }),
    conditionEntryBoolean: () =>
        editor('condition', {
            type: 'entry',
            select: { by: 'slot', index: 2 },
            field: 'boosted',
            op: '=',
            value: true,
        }),
    conditionAll: () => editor('condition', { type: 'all', of: [{ type: 'exposure', op: '<', value: 50 }] }),
    conditionNot: () => editor('condition', { type: 'not', condition: { type: 'exposure', op: '<', value: 50 } }),
    conditionUnknown: () => editor('condition', { type: 'nonsense' }),
    actionEnterPhoto: () => editor('action', { type: 'enterPhoto', photo: { memory: 'held' }, remember: 'slot1' }),
    actionSwap: () =>
        editor('action', { type: 'swap', entry: { by: 'bestRank' }, with: 'best', rememberRemoved: 'old' }),
    actionVote: () => editor('action', { type: 'vote', toExposure: 70 }),
    actionGoto: () => editor('action', { type: 'goto', phase: 'later' }),
    actionNotify: () => editor('action', { type: 'notify', message: 'Check' }),
    actionUnlockBoost: () => editor('action', { type: 'unlockBoost' }),
    selectorSlot: () => editor('selector', { by: 'slot', index: 0 }),
    selectorFastest: () => editor('selector', { by: 'fastest', window: '2h', skipProtected: true }),
    selectorMemory: () => editor('selector', { by: 'memory', slot: 'held' }),
    selectorBestRank: () => editor('selector', { by: 'bestRank' }),
    // 2026-03-04T12:00:00Z; the pause hints render clock times in UTC.
    pauseHintsActive: () =>
        hintList('2026-03-04T12:00:00Z', { votingPauseTime: ['11:30'], votingPauseDurationMinutes: 120 }),
    pauseHintsNext: () =>
        hintList('2026-03-04T12:00:00Z', { votingPauseTime: ['18:15'], votingPauseDurationMinutes: 90 }),
    fillHintsNext: () =>
        hintList(
            '2026-03-04T12:00:00Z',
            { scheduledFillTime: ['20:00'], scheduledFillWindowMinutes: 45 },
            'app.scheduledFill',
        ),
    fillHintsBeforeEnd: () =>
        hintList(
            '2026-03-04T12:00:00Z',
            { scheduledFillBeforeEnd: [1800], scheduledFillWindowMinutes: 60 },
            'app.scheduledFill',
        ),
    globalPauseNoTimes: () => globalHintList({ useVotingPause: true }),
};

const SETTINGS_BY_PREFIX = {
    useVotingPause: true,
    useScheduledFill: true,
    scheduledFillReplaces: false,
} as const;

function hintList(nowIso: string, overrides: Record<string, unknown>, which = 'app.votingPause') {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(nowIso));
    const values: Record<string, unknown> = { ...SETTINGS_BY_PREFIX, ...overrides };
    const hintsFor = challengeSettingHints({
        effectiveOf: (key) => values[key],
        appSettings: { timezone: 'UTC', checkFrequencyMax: 0 },
        challenge: invalid<Challenge>({ close_time: Math.floor(Date.parse(nowIso) / 1000) + 6 * 3600 }),
        profileReplacesWarning: false,
        t: translate,
    });
    const keys = which === 'app.votingPause' ? ['useVotingPause'] : ['useScheduledFill'];
    return (
        <div>
            {keys.map((key) => (
                <SettingHintList key={key} hints={hintsFor(key)} />
            ))}
        </div>
    );
}

function globalHintList(formValues: Record<string, unknown>) {
    const hintsFor = globalSettingHints({
        formValues,
        schema: emptySchema,
        timezone: 'UTC',
        t: translate,
    });
    return <SettingHintList hints={hintsFor('useVotingPause')} />;
}
const emptySchema: RendererSchema = {};

describe('renderer markup guard', () => {
    afterEach(() => jest.restoreAllMocks());

    const recording = Boolean(process.env.RECORD_MARKUP);
    const pinned: unknown = recording ? {} : JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    const expected = pinned as Markup;
    const pin = (name: string, html: string) => {
        if (recording) {
            recorded[name] = html;
            writeFileSync(DATA_FILE, `${JSON.stringify(recorded, null, 4)}\n`);
        } else expect(html).toBe(expected[name]);
    };

    test.each(Object.keys(CASES))('%s renders the pinned markup', (name) => {
        pin(name, render(CASES[name]!()).container.innerHTML);
    });

    test('languageSwitcherLatvian renders the pinned markup', async () => {
        const { container } = render(<LanguageSwitcher />);
        fireEvent.click(screen.getByText('common.languageLatvian'));
        await waitFor(() => expect(screen.getByText('Latviešu')).toBeTruthy());
        pin('languageSwitcherLatvian', container.innerHTML);
    });

    test('every pinned case still exists', () => {
        if (recording) return;
        expect(Object.keys(expected).sort()).toEqual([...Object.keys(CASES), 'languageSwitcherLatvian'].sort());
    });
});
