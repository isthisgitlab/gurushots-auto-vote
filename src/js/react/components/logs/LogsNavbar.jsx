import { useTranslation } from '@/contexts/TranslationContext';
import { ConnectionBadge } from '@/components/ui/StatusBadge';

/**
 * Navbar for the Logs page
 * Shows title and connection status
 */
export function LogsNavbar({ connected }) {
    const { t } = useTranslation();

    return (
        <div className="navbar bg-base-100 shadow-md">
            <div className="flex justify-between items-center px-4 py-2 max-w-6xl w-full mx-auto">
                <div className="flex items-center">
                    <span className="card-title text-latvian text-xl">
                        {t('logs.title')}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-sm">{t('logs.status')}</span>
                    <ConnectionBadge connected={connected} />
                </div>
            </div>
        </div>
    );
}
