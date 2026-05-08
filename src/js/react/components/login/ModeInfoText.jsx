import { useTranslation } from '@/contexts/TranslationContext';

/**
 * Bottom info text that changes based on mock mode
 */
export function ModeInfoText({ isMock }) {
    const { t } = useTranslation();

    const text = isMock ? t('login.mockModeInfo') : t('login.loadingModeInfo');

    return <p className="text-center text-sm mt-4 text-gray-500">{text}</p>;
}
