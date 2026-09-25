import { useTranslation } from '@/contexts/TranslationContext';

/**
 * A failed scenario request as the user sees it: what happened, why (the
 * first validation issues, with the place in the file), and what to do next.
 */
export function ScenarioError({ error }) {
    const { t } = useTranslation();
    if (!error) return null;
    return (
        <div className="alert alert-error py-2 text-sm flex-col items-start" role="alert">
            <span>
                {t(error.what)} {t('app.scenarioErrorNext')}
            </span>
            {error.issues?.length > 0 && (
                <ul className="text-xs list-disc ml-4">
                    {error.issues.slice(0, 5).map((issue) => (
                        <li key={`${issue.path}:${issue.message}`}>
                            {issue.path ? <code>{issue.path}</code> : null} {issue.message}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
