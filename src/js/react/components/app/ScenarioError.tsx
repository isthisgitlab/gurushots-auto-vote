import { useTranslation } from '@/contexts/TranslationContext';

import type { ScenarioIssue } from '../../../settings/scenarioSchema';

/**
 * A failed scenario request: the translation key of what happened, and the
 * validator's issues when the handler returned any.
 */
export type ScenarioErrorInfo = { what: string; issues?: ScenarioIssue[] };

/**
 * The validator issues a scenario IPC result carries: present only on a
 * validation failure, absent on success, on a refusal without detail and when
 * the call itself failed (null).
 */
export const issuesOf = (result: object | null | undefined): ScenarioIssue[] | undefined =>
    result && 'issues' in result ? (result as { issues?: ScenarioIssue[] }).issues : undefined;

/**
 * A failed scenario request as the user sees it: what happened, why (the
 * first validation issues, with the place in the file), and what to do next.
 */
export function ScenarioError({ error }: { error: ScenarioErrorInfo | null }) {
    const { t } = useTranslation();
    if (!error) return null;
    const issues = error.issues ?? [];
    return (
        <div className="alert alert-error py-2 text-sm flex-col items-start" role="alert">
            <span>
                {t(error.what)} {t('app.scenarioErrorNext')}
            </span>
            {issues.length > 0 && (
                <ul className="text-xs list-disc ml-4">
                    {issues.slice(0, 5).map((issue) => (
                        <li key={`${issue.path}:${issue.message}`}>
                            {issue.path ? <code>{issue.path}</code> : null} {issue.message}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
