import { useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';

/**
 * Language switcher dropdown component
 */
export function LanguageSwitcher() {
    const { t, language, setLanguage } = useTranslation();

    const handleLanguageChange = useCallback(
        async (newLang) => {
            await setLanguage(newLang);
            // Refresh menu with new language (a no-op stub on Capacitor).
            await window.api.refreshMenu();
        },
        [setLanguage],
    );

    const displayLanguage = language === 'en' ? 'English' : 'Latviešu';

    return (
        <div className="flex justify-end mb-4">
            <div className="dropdown dropdown-end">
                <div className="btn btn-ghost btn-sm" role="button" tabIndex={0}>
                    {/* Language icon */}
                    <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                        />
                    </svg>
                    <span>{displayLanguage}</span>
                </div>
                <ul className="dropdown-content z-[1] menu p-2 shadow bg-base-100 rounded-box w-32">
                    <li>
                        <button
                            type="button"
                            onClick={() => handleLanguageChange('en')}
                            className={language === 'en' ? 'active' : ''}
                            aria-pressed={language === 'en'}
                        >
                            {t('common.languageEnglish')}
                        </button>
                    </li>
                    <li>
                        <button
                            type="button"
                            onClick={() => handleLanguageChange('lv')}
                            className={language === 'lv' ? 'active' : ''}
                            aria-pressed={language === 'lv'}
                        >
                            {t('common.languageLatvian')}
                        </button>
                    </li>
                </ul>
            </div>
        </div>
    );
}
