import { useTranslation } from '@/contexts/TranslationContext';
import { formatDuration } from '@/utils/formatters';
import { openBoostWindows } from '../../../voting/boostWindow';
import { useTick } from '@/hooks/useTick';

// A turbo is "available" for this challenge when it's ready to apply (WON) or
// ready to earn (FREE / in progress / cooldown elapsed).
const isTurboAvailable = (turbo, now) => {
    const state = turbo?.state;
    if (state === 'WON' || state === 'FREE' || state === 'IN_PROGRESS') return true;
    return state === 'TIMER' && typeof turbo?.time_to_open === 'number' && turbo.time_to_open <= now;
};

function HeaderStat({ icon, value, label }) {
    return (
        <div className="flex items-baseline gap-1 whitespace-nowrap">
            <span aria-hidden="true">{icon}</span>
            <span className="font-semibold">{value}</span>
            <span className="text-base-content/60">{label}</span>
        </div>
    );
}

// Render a balance, or an em-dash when it could not be read — NEVER 0, which
// would falsely imply an empty balance and mislead a paid-join decision.
const fmtBalance = (v) => (Number.isFinite(v) ? v : '—');

/**
 * Bankroll pills (keys/swaps/fills/coins). Wrapped in its own polite live region
 * — unlike the ambient countdown, a balance change after a join/spend IS worth
 * announcing, and this node has no per-second tick to make that noisy.
 */
function BankrollStats({ bankroll }) {
    const { t } = useTranslation();
    const b = bankroll || null;
    return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1" role="status" aria-live="polite">
            <HeaderStat icon="🔑" value={fmtBalance(b?.keys)} label={t('app.bankrollKeys')} />
            <HeaderStat icon="🔄" value={fmtBalance(b?.swaps)} label={t('app.bankrollSwaps')} />
            <HeaderStat icon="🧩" value={fmtBalance(b?.fills)} label={t('app.bankrollFills')} />
            <HeaderStat icon="🪙" value={fmtBalance(b?.coins)} label={t('app.bankrollCoins')} />
        </div>
    );
}

/**
 * Isolated 1Hz countdown for the next armed autovote cycle. Kept in its own
 * component so the per-second tick re-renders ONLY this node — never the parent
 * StatusHeader / AppContent / challenge list (which are deliberately optimized
 * against a 1Hz cascade). The time is advisory: computeNextCycleDelayMs
 * recomputes each cycle, so it is `~`-prefixed like the deadline timeline.
 */
function NextActionCountdown({ nextRunAt, running }) {
    const { t } = useTranslation();
    const enabled = running && typeof nextRunAt === 'number';
    const now = useTick(1000, enabled);
    if (!running) return <span className="opacity-70">{t('app.statusHeaderNotRunning')}</span>;
    if (typeof nextRunAt !== 'number') return <span className="opacity-70">—</span>;
    const remaining = Math.round(nextRunAt / 1000) - now;
    return (
        <span title={t('app.statusHeaderNextApprox')}>
            {remaining > 0 ? `~${formatDuration(remaining, { includeSeconds: true })}` : t('app.deadlineDue')}
        </span>
    );
}

/**
 * At-a-glance summary bar above the challenge list: active-challenge count,
 * boosts/turbos available right now, and the next armed autovote action.
 *
 * The three counts derive from the already-fetched, reference-stable
 * `challenges` array and recompute only when it changes — NO tick here, so the
 * header body never re-renders on the countdown's clock. Responsive: the row
 * wraps on narrow viewports rather than using wide DaisyUI `stat` blocks.
 */
export function StatusHeader({ challenges, nextRunAt, running, bankroll }) {
    const { t } = useTranslation();
    const list = Array.isArray(challenges) ? challenges : [];
    const nowSec = Math.floor(Date.now() / 1000);
    const activeCount = list.length;
    const boostsAvailable = openBoostWindows(list, nowSec).length;
    const turbosAvailable = list.filter((c) => isTurboAvailable(c.member?.turbo, nowSec)).length;

    // Show the bar whenever there's a balance to display, even with no active
    // challenges and autovote idle — that's exactly when a user browses Discover
    // and needs to see their coins before a paid join. Only fully idle + no
    // bankroll hides it.
    const hasBankroll = bankroll !== undefined && bankroll !== null;
    if (activeCount === 0 && !running && !hasBankroll) return null;

    return (
        // Deliberately NOT role="status"/aria-live: the next-action countdown
        // inside re-renders every second, and a live region would make a screen
        // reader re-announce the whole bar each tick. It's an ambient summary,
        // not an alert.
        <div
            className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm rounded-lg border border-base-300 bg-base-100 px-3 py-2 mb-3"
            data-testid="status-header"
        >
            <HeaderStat icon="🏆" value={activeCount} label={t('app.statusHeaderActive')} />
            <HeaderStat icon="🚀" value={boostsAvailable} label={t('app.statusHeaderBoosts')} />
            <HeaderStat icon="⚡" value={turbosAvailable} label={t('app.statusHeaderTurbos')} />
            <div className="flex items-baseline gap-1 whitespace-nowrap">
                <span aria-hidden="true">⏳</span>
                <span className="text-base-content/60">{t('app.statusHeaderNext')}:</span>
                <NextActionCountdown nextRunAt={nextRunAt} running={running} />
            </div>
            {hasBankroll && <BankrollStats bankroll={bankroll} />}
        </div>
    );
}
