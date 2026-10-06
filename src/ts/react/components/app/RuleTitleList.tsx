import { useTranslation } from '@/contexts/TranslationContext';
import { ruleTitleModes } from '../../../settings/challengeRules';

import type { LooseRecord, TitleRule } from '../../../types/settings';
import type { RulePatchHandler } from './RuleFields';

// Mirrors MAX_TITLES_PER_RULE in settings/titleRuleSanitize.ts; the sanitizer is the real gate.
const MAX_TITLES_PER_RULE = 50;

// The editable title list of a rule. Stored rules carry `titles` only when they
// list more than one (with `title` mirroring the first). Always at least one row
// so a fresh rule shows an input.
const ruleTitleRows = (rule: TitleRule): string[] => {
    if (Array.isArray(rule.titles) && rule.titles.length > 0) return rule.titles;
    return [rule.title ?? ''];
};

// Patch for a new title list. `title` follows the first row so the saved shape
// stays readable by single-title code; the sanitizer drops empty rows.
const titlesPatch = (titles: string[]): LooseRecord => ({ titles, title: titles[0] ?? '' });

function RuleTitleRow({
    title,
    mode,
    index,
    count,
    onTitleChange,
    onModeChange,
    onRemove,
}: {
    title: string;
    mode: string;
    index: number;
    count: number;
    onTitleChange: (title: string) => void;
    onModeChange: (mode: string) => void;
    onRemove: () => void;
}) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
            <input
                type="text"
                className="input input-sm min-w-32 flex-1"
                placeholder={t('app.titleTagRuleTitlePlaceholder')}
                aria-label={`${t('app.titleTagRuleTitle')} ${index + 1}`}
                value={title}
                onChange={(e) => onTitleChange(e.currentTarget.value)}
            />
            <select
                aria-label={`${t('app.titleRuleMatch')} ${index + 1}`}
                className="select select-sm w-32"
                disabled={typeof title !== 'string' || !title.trim()}
                value={typeof title === 'string' && title.trim() ? mode : 'exact'}
                onChange={(e) => onModeChange(e.currentTarget.value)}
            >
                <option value="exact">{t('app.titleRuleMatchExact')}</option>
                <option value="starts">{t('app.titleRuleMatchStarts')}</option>
                <option value="contains">{t('app.titleRuleMatchContains')}</option>
            </select>
            {count > 1 && (
                <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    title={t('app.removeTitleRuleTitle')}
                    aria-label={`${t('app.removeTitleRuleTitle')} ${index + 1}`}
                    onClick={onRemove}
                >
                    ×
                </button>
            )}
        </div>
    );
}

export function RuleTitleList({ rule, onPatch }: { rule: TitleRule; onPatch: RulePatchHandler }) {
    const { t } = useTranslation();
    const titles = ruleTitleRows(rule);
    const modes = ruleTitleModes(rule);
    const setTitles = (next: string[], nextModes: string[]) =>
        onPatch({ ...titlesPatch(next), ...(rule.titleMatchModes ? { titleMatchModes: nextModes } : {}) });
    return (
        <div className="space-y-2">
            {titles.map((title, titleIndex) => (
                // Index key: rows are only appended or removed, and the input is controlled.
                <RuleTitleRow
                    key={titleIndex}
                    title={title}
                    mode={modes[titleIndex] ?? 'exact'}
                    index={titleIndex}
                    count={titles.length}
                    onTitleChange={(next) =>
                        setTitles(
                            titles.map((v, i) => (i === titleIndex ? next : v)),
                            modes,
                        )
                    }
                    onModeChange={(next) =>
                        onPatch({
                            ...(titles.length === 1 ? { match: next } : {}),
                            titleMatchModes: modes.map((mode, i) => (i === titleIndex ? next : mode)),
                        })
                    }
                    onRemove={() =>
                        setTitles(
                            titles.filter((_, i) => i !== titleIndex),
                            modes.filter((_, i) => i !== titleIndex),
                        )
                    }
                />
            ))}
            <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={titles.length >= MAX_TITLES_PER_RULE}
                onClick={() => setTitles([...titles, ''], [...modes, rule.match ?? 'exact'])}
            >
                + {t('app.addTitleRuleTitle')}
            </button>
        </div>
    );
}
