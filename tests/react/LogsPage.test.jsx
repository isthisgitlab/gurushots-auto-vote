/**
 * Logs window page (pages/Logs.jsx) — shows a loader until translations are
 * ready, then the navbar (connection status from useLogStream) and the log
 * list. It mounts itself into #root at module load when that element exists.
 */
import { render, screen, waitFor } from '@testing-library/preact';

describe('Logs page', () => {
    let originalBacklog;

    beforeEach(() => {
        originalBacklog = window.api.getLogBacklog;
        window.api.getLogBacklog = jest
            .fn()
            .mockResolvedValue([{ seq: 1, timestamp: 'T', level: 'INFO', message: 'hello log' }]);
    });

    afterEach(() => {
        window.api.getLogBacklog = originalBacklog;
        document.body.innerHTML = '';
    });

    test('loader, then the connected navbar and the backlog', async () => {
        const { default: LogsPage } = await import('@/pages/Logs');
        // Imported without #root: nothing auto-mounted.
        expect(document.body.textContent).toBe('');

        render(<LogsPage />);
        expect(screen.getByText('common.loading')).toBeTruthy();
        await waitFor(() => expect(screen.getByText('hello log')).toBeTruthy());
        expect(screen.getByText('logs.title')).toBeTruthy();
        expect(screen.getByText('logs.connected')).toBeTruthy();
    });

    test('auto-mounts into #root at module load', async () => {
        const root = document.createElement('div');
        root.id = 'root';
        document.body.appendChild(root);
        jest.isolateModules(() => {
            require('@/pages/Logs');
        });
        await waitFor(() => expect(root.textContent).toContain('hello log'));
    });
});
