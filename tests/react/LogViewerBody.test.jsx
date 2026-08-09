/**
 * Tests for the shared LogViewerBody (components/logs/LogViewerBody) —
 * the terminal-style log list extracted from the Logs page and LogsModal.
 */

import { render, screen } from './helpers/test-utils';
import { LogViewerBody } from '@/components/logs/LogViewerBody';

const entry = (message, over = {}) => ({
    timestamp: '2026-01-01 12:00:00',
    level: 'INFO',
    context: 'GUI',
    category: 'general',
    message,
    ...over,
});

describe('LogViewerBody', () => {
    test('renders the empty state when there are no entries', () => {
        render(<LogViewerBody entries={[]} heightClass="h-[600px]" />);
        expect(screen.getByText('logs.empty')).toBeTruthy();
    });

    test('renders one LogEntry per entry', () => {
        const { container } = render(
            <LogViewerBody entries={[entry('first line'), entry('second line')]} heightClass="h-[60vh]" />,
        );
        expect(container.querySelectorAll('.log-entry')).toHaveLength(2);
        expect(screen.getByText('first line')).toBeTruthy();
        expect(screen.getByText('second line')).toBeTruthy();
    });

    test('applies the host height class on the shared scroll container', () => {
        const { container } = render(<LogViewerBody entries={[]} heightClass="h-[600px]" />);
        expect(container.firstChild.className).toBe(
            'h-[600px] overflow-y-auto bg-gray-900 text-green-400 font-mono text-sm p-4 rounded-lg',
        );
    });
});
