/**
 * WelcomeModal — the first-run onboarding. Verifies it renders the intro and
 * dismiss action, that the Android-only battery-optimization guidance is gated
 * on the Capacitor platform, and that "Got it" calls onClose. (The test mock's
 * t() returns the key, so assertions match translation keys.)
 */
import { fireEvent, render, screen } from './helpers/test-utils';
import type { RendererGlobals } from '../../src/ts/types/capacitor';
import { WelcomeModal } from '@/components/app/WelcomeModal';

const g = globalThis as RendererGlobals;

describe('WelcomeModal', () => {
    afterEach(() => {
        delete g.Capacitor;
    });

    test('renders intro and dismiss action when open', () => {
        render(<WelcomeModal isOpen onClose={() => {}} />);
        expect(screen.getByText('onboarding.intro')).toBeTruthy();
        expect(screen.getByText('onboarding.howItWorks')).toBeTruthy();
        expect(screen.getByText('onboarding.gotIt')).toBeTruthy();
    });

    test('hides the battery guidance off Capacitor', () => {
        render(<WelcomeModal isOpen onClose={() => {}} />);
        expect(screen.queryByText('onboarding.batteryBody')).toBeNull();
    });

    test('shows the battery guidance on Capacitor', () => {
        g.Capacitor = { isNativePlatform: () => true };
        render(<WelcomeModal isOpen onClose={() => {}} />);
        expect(screen.getByText('onboarding.batteryBody')).toBeTruthy();
    });

    test('a re-render with the same onClose keeps the open modal set up once', () => {
        const onClose = jest.fn();
        const addListener = jest.spyOn(document, 'addEventListener');
        const { rerender } = render(<WelcomeModal isOpen onClose={onClose} />);
        const keydowns = () => addListener.mock.calls.filter(([type]) => type === 'keydown').length;
        const attached = keydowns();
        rerender(<WelcomeModal isOpen onClose={onClose} />);
        expect(keydowns()).toBe(attached);
        addListener.mockRestore();
    });

    test('Got it calls onClose', () => {
        const onClose = jest.fn();
        render(<WelcomeModal isOpen onClose={onClose} />);
        fireEvent.click(screen.getByText('onboarding.gotIt'));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
