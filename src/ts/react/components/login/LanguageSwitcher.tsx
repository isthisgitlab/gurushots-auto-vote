import { useTranslation } from '@/contexts/TranslationContext';
import { FocusDropdown } from '@/components/ui/FocusDropdown';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';

const LANGUAGE_NAME_KEYS: Record<string, string> = { en: 'common.languageEnglish', lv: 'common.languageLatvian' };

/**
 * Language switcher dropdown component. Each language is named in itself and marked with its own `lang`, so a
 * screen reader pronounces it correctly whatever the UI language is.
 */
export function LanguageSwitcher() {
    const { t, language, setLanguage } = useTranslation();

    const languageItem = (code: string) => (
        <li>
            <button
                type="button"
                lang={code}
                onClick={() => void setLanguage(code)}
                className={language === code ? 'active' : ''}
                aria-pressed={language === code}
            >
                {t(LANGUAGE_NAME_KEYS[code])}
            </button>
        </li>
    );

    return (
        <div className="flex justify-end mb-4">
            <FocusDropdown
                className="dropdown-end"
                triggerClassName="btn btn-outline btn-sm"
                menuClassName="z-[1] menu p-2 shadow bg-base-100 rounded-box w-32"
                trigger={
                    <>
                        {/* Language icon */}
                        <StrokeIcon className="w-4 h-4 mr-1" d={ICON_PATHS.translate} />
                        <span lang={language}>{t(LANGUAGE_NAME_KEYS[language])}</span>
                    </>
                }
            >
                {languageItem('en')}
                {languageItem('lv')}
            </FocusDropdown>
        </div>
    );
}
