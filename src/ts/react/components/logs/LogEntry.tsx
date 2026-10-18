import type { GuiLogEntry } from '../../../logger';
import { sentenceCaseLogMessage } from '../../../format/logSafe';
import { useTranslation } from '@/contexts/TranslationContext';
import { localizeLogMessage } from './localizeLogMessage';
/**
 * Severity → daisyUI badge tone. Strict 4-value set matches logger.ts.
 */
const LEVEL_BADGES = {
    DEBUG: 'badge-neutral',
    INFO: 'badge-info',
    WARN: 'badge-warning',
    ERROR: 'badge-error',
};
const CATEGORY_KEYS: Record<string, true> = {
    api: true, authentication: true, autoSubmit: true, boost: true, challenges: true, claim: true,
    currency: true, error: true, general: true, join: true, lexicon: true, middleware: true,
    missions: true, scenario: true, settings: true, translation: true, turbo: true, ui: true,
    update: true, voting: true,
};

/**
 * The fields a log line renders — a logger ring-buffer entry or a live GUI
 * fan-out entry both carry them.
 */
export type LogLine = Pick<GuiLogEntry, 'level' | 'message' | 'context' | 'timestamp' | 'category'>;

/**
 * Single log entry. The timestamp, three small badges, then the message:
 *   [timestamp] (severity) (context) (category) message
 */
export function LogEntry({ entry }: { entry: LogLine }) {
    const { level, message, context, timestamp, category } = entry;
    const { language, t } = useTranslation();
    const levelBadge = LEVEL_BADGES[level] || 'badge-neutral';
    const categoryName = category || 'general';

    return (
        <div className="log-entry whitespace-pre-wrap break-words">
            <span className="text-base-content/70">[{timestamp}]</span>
            {' '}
            <span className={`badge badge-sm ${levelBadge}`}>{language === 'lv' && level in LEVEL_BADGES ? t(`logs.levels.${level}`) : level}</span>
            {' '}
            <span className="badge badge-sm badge-ghost">{context || 'APP'}</span>
            {' '}
            <span className="badge badge-sm badge-ghost">{language === 'lv' && CATEGORY_KEYS[categoryName] ? t(`logs.categories.${categoryName}`) : categoryName}</span>
            {' '}
            {/* JSX text is escaped by the renderer; pre-escaping would show "&lt;" literally. */}
            <span className="text-base-content">{sentenceCaseLogMessage(language === 'lv' ? localizeLogMessage(message) : message)}</span>
        </div>
    );
}

/**
 * Empty state when no logs are present
 */
export function LogsEmptyState({ text }: { text: string }) {
    return (
        <div className="text-base-content/70 text-center py-8">
            {text}
        </div>
    );
}
