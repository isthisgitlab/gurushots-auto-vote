import { useTranslation } from '@/contexts/TranslationContext';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';

/**
 * Language switcher dropdown component
 */
export function LanguageSwitcher() {
    const { t, language, setLanguage } = useTranslation();

    const languageItem = (code: string, label: string) => (
        <li>
            <button
                type="button"
                onClick={() => void setLanguage(code)}
                className={language === code ? 'active' : ''}
                aria-pressed={language === code}
            >
                {label}
            </button>
        </li>
    );

    const displayLanguage = language === 'en' ? 'English' : 'Latviešu';

    return (
        <div className="flex justify-end mb-4">
            <div className="dropdown dropdown-end">
                <div className="btn btn-outline btn-sm" role="button" tabIndex={0}>
                    {/* Language icon */}
                    <StrokeIcon className="w-4 h-4 mr-1" d={ICON_PATHS.translate} />
                    <span>{displayLanguage}</span>
                </div>
                <ul className="dropdown-content z-[1] menu p-2 shadow bg-base-100 rounded-box w-32">
                    {languageItem('en', t('common.languageEnglish'))}
                    {languageItem('lv', t('common.languageLatvian'))}
                </ul>
            </div>
        </div>
    );
}
