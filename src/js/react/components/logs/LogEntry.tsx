import type { GuiLogEntry } from '../../../logger';
import { useTranslation } from '@/contexts/TranslationContext';
import { localizeLogMessage } from './localizeLogMessage';
/**
 * Severity → text color. Strict 4-value set matches logger.ts.
 */
const LEVEL_COLORS = {
    DEBUG: 'text-gray-400',
    INFO: 'text-blue-400',
    WARN: 'text-yellow-400',
    ERROR: 'text-red-400',
};
const CATEGORY_KEYS: Record<string, true> = {
    api: true, authentication: true, autoFill: true, boost: true, challenges: true, claim: true,
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
 * Single log entry. Three small badges then the message:
 *   [severity] [context] [category] message
 */
export function LogEntry({ entry }: { entry: LogLine }) {
    const { level, message, context, timestamp, category } = entry;
    const { language, t } = useTranslation();
    const levelColor = LEVEL_COLORS[level] || 'text-green-400';
    const categoryName = category || 'general';

    return (
        <div className="log-entry whitespace-pre-wrap break-words">
            <span className="text-gray-400">[{timestamp}]</span>
            {' '}
            <span className={levelColor}>[{language === 'lv' && level in LEVEL_COLORS ? t(`logs.levels.${level}`) : level}]</span>
            {' '}
            <span className="text-cyan-400">[{context || 'APP'}]</span>
            {' '}
            <span className="text-yellow-400">[{language === 'lv' && CATEGORY_KEYS[categoryName] ? t(`logs.categories.${categoryName}`) : categoryName}]</span>
            {' '}
            {/* JSX text is escaped by the renderer; pre-escaping would show "&lt;" literally. */}
            <span className="text-white">{language === 'lv' ? localizeLogMessage(message) : message}</span>
        </div>
    );
}

/**
 * Empty state when no logs are present
 */
export function LogsEmptyState({ text }: { text: string }) {
    return (
        <div className="text-gray-500 text-center py-8">
            {text}
        </div>
    );
}
