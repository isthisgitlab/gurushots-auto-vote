/**
 * WelcomeModal — the first-run onboarding. Verifies it renders the intro and
 * dismiss action, that the Android-only battery-optimization guidance is gated
 * on the Capacitor platform, and that "Got it" calls onClose. (The test mock's
 * t() returns the key, so assertions match translation keys.)
 */
import { fireEvent, render, screen } from '@/test/test-utils';
import { WelcomeModal } from '@/components/app/WelcomeModal';

describe('WelcomeModal', () => {
    afterEach(() => {
        delete globalThis.Capacitor;
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
        globalThis.Capacitor = { isNativePlatform: () => true };
        render(<WelcomeModal isOpen onClose={() => {}} />);
        expect(screen.getByText('onboarding.batteryBody')).toBeTruthy();
    });

    test('Got it calls onClose', () => {
        const onClose = jest.fn();
        render(<WelcomeModal isOpen onClose={onClose} />);
        fireEvent.click(screen.getByText('onboarding.gotIt'));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
