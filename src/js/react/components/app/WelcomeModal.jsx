import { useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { Modal, ModalActions } from '@/components/ui/Modal';

/** @import { RendererGlobals } from '../../../types/capacitor' */

// Detect a real native (Android) platform without importing the node-flavored
// runtime module into the browser bundle. The background-permission guidance
// only applies when actually running natively — calling isNativePlatform()
// (not just checking it exists) excludes any Capacitor web target.
const isCapacitorPlatform = () => /** @type {RendererGlobals} */ (globalThis).Capacitor?.isNativePlatform?.() === true;

/**
 * One-time first-run welcome. Explains what the app does and, on Android,
 * nudges the user to exclude it from battery optimization so unattended
 * voting survives Doze / vendor battery killers. Shown until the parent
 * persists the `onboardingCompleted` setting on close.
 *
 * @param {{ isOpen: boolean, onClose: () => void | Promise<void> }} props
 */
export function WelcomeModal({ isOpen, onClose }) {
    const { t } = useTranslation();
    const showBatteryGuidance = isCapacitorPlatform();
    // Stable across renders: Modal's open effect (focus trap, keydown
    // listener, scroll lock) re-runs whenever its onClose changes.
    const close = useCallback(() => void onClose(), [onClose]);

    return (
        <Modal isOpen={isOpen} onClose={close} title={t('onboarding.title')} size="md" showCloseButton={false}>
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
                <button type="button" className="btn btn-primary btn-sm" onClick={close}>
                    {t('onboarding.gotIt')}
                </button>
            </ModalActions>
        </Modal>
    );
}
