import { useEffect, useMemo } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import * as ipc from '@/api/ipc';
import { isRefusalCode, scenarioIssueText, scenarioPathText } from '@/utils/scenarioIssueText';

import type { ScenarioIssue } from '../../../core/settings/scenarioSchema';

/**
 * A failed scenario request: the translation key of what happened, the key of
 * the next step (`next` overrides the default "Fix it and try again." — a
 * refusal where nothing is wrong with the scenario words its own), and the
 * validator's issues when the handler returned any.
 */
export type ScenarioErrorInfo = { what: string; next?: string; issues?: ScenarioIssue[] };

/**
 * The validator issues a scenario IPC result carries: present only on a
 * validation failure, absent on success, on a refusal without detail and when
 * the call itself failed (null).
 */
export const issuesOf = (result: object | null | undefined): ScenarioIssue[] | undefined =>
    result && 'issues' in result ? (result as { issues?: ScenarioIssue[] }).issues : undefined;

/**
 * What a refused write says about itself: its validator issues when it has them, else its reason code as one issue (a
 * refusal of the lifecycle gate, a revision conflict, a stop time already past — each words its own next step), else
 * nothing (the call itself failed, or the reason is no code the app words: an exception's text never reaches the user).
 */
export const failureIssuesOf = (result: object | null | undefined): ScenarioIssue[] | undefined => {
    const issues = issuesOf(result);
    if (issues !== undefined) return issues;
    const reason = result && 'error' in result ? (result as { error?: unknown }).error : undefined;
    return typeof reason === 'string' && isRefusalCode(reason) ? [{ path: '', message: reason }] : undefined;
};

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
                {t(error.what)} {t(error.next ?? 'app.scenarioErrorNext')}
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
