/**
 * LogsModal — the in-app log viewer that gives the Capacitor (Android) build a
 * live log view (Electron uses a dedicated menu window). Verifies it renders
 * only when open and shows the empty state + connection status. The test mock's
 * t() returns the key, so assertions match translation keys; the global
 * window.api mock makes useLogStream resolve with an empty backlog.
 */
import { render, screen } from '@/test/test-utils';
import { LogsModal } from '@/components/app/LogsModal';

describe('LogsModal', () => {
    test('renders nothing when closed', () => {
        render(<LogsModal isOpen={false} onClose={() => {}} />);
        expect(screen.queryByText('logs.title')).toBeNull();
    });

    test('renders the title, status, and empty state when open', () => {
        render(<LogsModal isOpen onClose={() => {}} />);
        expect(screen.getByText('logs.title')).toBeTruthy();
        expect(screen.getByText('logs.status')).toBeTruthy();
        expect(screen.getByText('logs.empty')).toBeTruthy();
    });
});
