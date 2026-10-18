/**
 * LogEntry — one terminal-style log line: [timestamp], then the level, context
 * and category as badges, then the message, with a level→badge map and fallbacks for the optional
 * fields. LogsNavbar — the Logs window header with its connection badge.
 */
import { render, screen, waitFor } from './helpers/test-utils';
import { LogEntry, LogsEmptyState } from '@/components/logs/LogEntry';
import { LogsNavbar } from '@/components/logs/LogsNavbar';
import { mockApi, mockTranslator } from './helpers/setup';
import { invalid } from '../helpers/invalid';
import { createTranslator } from '../../src/ts/translations/translator';

describe('LogEntry', () => {
    test('shows an existing log message in the selected Latvian language', async () => {
        mockApi.getSetting.mockResolvedValue('lv');
        const translator = createTranslator();
        mockTranslator.t.mockImplementation((key) => translator.t(key, 'lv'));
        try {
            const { container } = render(
                <LogEntry
                    entry={{
                        timestamp: 'T1',
                        level: 'INFO',
                        context: 'MAIN',
                        category: 'voting',
                        message: 'ℹ️ Invalid timestamp provided',
                    }}
                />,
            );
            await waitFor(() => expect(container.textContent).toContain('Norādīts nederīgs laika zīmogs'));
            expect(container.textContent).toContain('[T1] Informācija MAIN Balsošana');
        } finally {
            mockApi.getSetting.mockResolvedValue(null);
            mockTranslator.t.mockImplementation((key) => key);
        }
    });

    test.each([
        ['DEBUG', 'badge-neutral'],
        ['INFO', 'badge-info'],
        ['WARN', 'badge-warning'],
        ['ERROR', 'badge-error'],
    ] as const)('renders every badge and gives a %s level its %s tone', (level, tone) => {
        const { container } = render(
            <LogEntry entry={{ timestamp: 'T1', level, context: 'MAIN', category: 'voting', message: 'boom' }} />,
        );
        expect(container.textContent).toBe(`[T1] ${level} MAIN voting Boom`);
        expect(screen.getByText(level).className).toBe(`badge badge-sm ${tone}`);
        expect(screen.getByText('MAIN').className).toBe('badge badge-sm badge-ghost');
        expect(screen.getByText('voting').className).toBe('badge badge-sm badge-ghost');
        expect(screen.getByText('[T1]').className).toBe('text-base-content/70');
    });

    test('sentence-cases a previously saved English log line', () => {
        const { container } = render(
            <LogEntry
                entry={{
                    timestamp: 'T1',
                    level: 'INFO',
                    context: 'GUI',
                    category: 'join',
                    message: 'ℹ️ joining up to 4 challenge(s) early for the active missions',
                }}
            />,
        );
        expect(container.textContent).toContain('ℹ️ Joining up to 4 challenge(s) early for the active missions');
    });

    test('falls back for an unknown level, missing context/category and an empty message', () => {
        const { container } = render(<LogEntry entry={invalid({ timestamp: 'T2', level: 'TRACE', message: '' })} />);
        expect(container.textContent).toBe('[T2] TRACE APP general ');
        expect(container.querySelectorAll('span')[1].className).toBe('badge badge-sm badge-neutral');
    });

    test('keeps unknown badges as codes in Latvian', async () => {
        mockApi.getSetting.mockResolvedValue('lv');
        try {
            const { container } = render(
                <LogEntry entry={invalid({ timestamp: 'T2', level: 'TRACE', category: 'plugin', message: '' })} />,
            );
            await waitFor(() => expect(container.textContent).toContain('TRACE APP plugin'));
        } finally {
            mockApi.getSetting.mockResolvedValue(null);
        }
    });

    test('shows markup in the message as literal text, escaped once', () => {
        const { container } = render(
            <LogEntry entry={invalid({ timestamp: 'T3', level: 'INFO', message: '<b>x</b>' })} />,
        );
        expect(container.querySelector('.text-base-content')!.textContent).toBe('<b>x</b>');
        expect(container.querySelector('b')).toBeNull();
    });

    test('LogsEmptyState shows the given text', () => {
        render(<LogsEmptyState text="nothing here" />);
        expect(screen.getByText('nothing here').className).toBe('text-base-content/70 text-center py-8');
    });
});

describe('LogsNavbar', () => {
    test('shows the title, status label and the connected badge', () => {
        render(<LogsNavbar connected />);
        expect(screen.getByText('logs.title')).toBeTruthy();
        expect(screen.getByText('logs.status')).toBeTruthy();
        expect(screen.getByText('logs.connected')).toBeTruthy();
    });

    test('shows the disconnected badge', () => {
        render(<LogsNavbar connected={false} />);
        expect(screen.getByText('logs.disconnected')).toBeTruthy();
    });
});
