import { useTranslation } from '@/contexts/TranslationContext';
import { Modal, ModalActions } from '@/components/ui/Modal';

// Detect a real native (Android) platform without importing the node-flavored
// runtime module into the browser bundle. The background-permission guidance
// only applies when actually running natively — calling isNativePlatform()
// (not just checking it exists) excludes any Capacitor web target.
const isCapacitorPlatform = () => globalThis.Capacitor?.isNativePlatform?.() === true;

/**
 * One-time first-run welcome. Explains what the app does and, on Android,
 * nudges the user to exclude it from battery optimization so unattended
 * voting survives Doze / vendor battery killers. Shown until the parent
 * persists the `onboardingCompleted` setting on close.
 */
export function WelcomeModal({ isOpen, onClose }) {
    const { t } = useTranslation();
    const showBatteryGuidance = isCapacitorPlatform();

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t('onboarding.title')} size="md" showCloseButton={false}>
            <div className="space-y-4">
                <p className="text-sm">{t('onboarding.intro')}</p>

                <div>
                    <h4 className="font-semibold text-sm">{t('onboarding.howItWorksTitle')}</h4>
                    <p className="text-sm text-base-content/80">{t('onboarding.howItWorks')}</p>
                </div>

                {showBatteryGuidance && (
                    <div className="alert alert-info text-sm">
                        <div>
                            <h4 className="font-semibold">{t('onboarding.batteryTitle')}</h4>
                            <p>{t('onboarding.batteryBody')}</p>
                        </div>
                    </div>
                )}
            </div>

            <ModalActions>
                <button type="button" className="btn btn-primary" onClick={onClose}>
                    {t('onboarding.gotIt')}
                </button>
            </ModalActions>
        </Modal>
    );
}
