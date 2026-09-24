import { useTranslation } from '@/contexts/TranslationContext';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';

/**
 * Language switcher dropdown component
 */
export function LanguageSwitcher() {
    const { t, language, setLanguage } = useTranslation();

    const displayLanguage = language === 'en' ? 'English' : 'Latviešu';

    return (
        <div className="flex justify-end mb-4">
            <div className="dropdown dropdown-end">
                <div className="btn btn-ghost btn-sm" role="button" tabIndex={0}>
                    {/* Language icon */}
                    <StrokeIcon className="w-4 h-4 mr-1" d={ICON_PATHS.translate} />
                    <span>{displayLanguage}</span>
                </div>
                <ul className="dropdown-content z-[1] menu p-2 shadow bg-base-100 rounded-box w-32">
                    <li>
                        <button
                            type="button"
                            onClick={() => setLanguage('en')}
                            className={language === 'en' ? 'active' : ''}
                            aria-pressed={language === 'en'}
                        >
                            {t('common.languageEnglish')}
                        </button>
                    </li>
                    <li>
                        <button
                            type="button"
                            onClick={() => setLanguage('lv')}
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
