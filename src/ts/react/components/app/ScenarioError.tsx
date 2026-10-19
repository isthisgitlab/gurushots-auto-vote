import { useEffect, useMemo } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import * as ipc from '@/api/ipc';
import { scenarioIssueText, scenarioPathText } from '@/utils/scenarioIssueText';

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
 * first validation issues, worded in the UI's language, with the place in the
 * file), and what to do next. A validator message with no wording here is shown
 * as a generic line and its original text goes to the log.
 */
export function ScenarioError({ error }: { error: ScenarioErrorInfo | null }) {
    const { t } = useTranslation();
    const issues = useMemo(
        () => (error?.issues ?? []).slice(0, 5).map((issue) => ({ ...issue, ...scenarioIssueText(issue.message, t) })),
        [error, t],
    );
    useEffect(() => {
        for (const issue of issues) {
            if (!issue.known) {
                void ipc.logRendererDebug(`Scenario issue without wording at "${issue.path}": ${issue.message}`);
            }
        }
    }, [issues]);
    if (!error) return null;
    return (
        <div className="alert alert-error py-2 text-sm flex-col items-start" role="alert">
            <span>
                {t(error.what)} {t('app.scenarioErrorNext')}
            </span>
            {issues.length > 0 && (
                <ul className="text-xs list-disc ml-4">
                    {issues.map((issue) => (
                        <li key={`${issue.path}:${issue.message}`}>
                            {issue.path ? (
                                <span className="font-medium">{scenarioPathText(issue.path, t)}:</span>
                            ) : null}{' '}
                            {issue.text}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
