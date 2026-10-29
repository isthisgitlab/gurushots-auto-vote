/**
 * The CLI `challenges` command: the active challenges with their ids — the id
 * every `--challenge=<id>` command needs — plus the state each action cares
 * about (close time, entries/slots, exposure, boost, turbo, rank). One fetch
 * through `getMiddleware().getActiveChallenges()`, the same one `status` uses;
 * every per-challenge read is optional-chained, so a challenge with a partial
 * standing still lists with what can be read. The turbo line names the command
 * that can run right now: play it (`turbo --challenge=<id>`), or apply a won
 * Turbo to a photo (`turbo --challenge=<id> --image=<photo id>`, with the
 * photo ids in the `--challenge=<id>` detail view).
 */

import * as logger from '../../logger';
import { ensureAuthenticated } from '../guards';
import { getMiddleware } from '../../apiFactory';
import { findActiveChallenge } from '../../services/findActiveChallenge';
import { formatDuration } from '../../format/duration';
import { stripTerminalControl } from '../../format/logSafe';
import { isMarkedChallenge } from '../../challengeMarks';
import { canPlayTurbo, isKnownTurboMode } from '../../voting/turboMode';
import { finiteOr, isInteger } from '../../numbers';
import { rankingTail } from './status';
import { errorMessage } from '../../errorMessage';

import type { Challenge, MemberTurbo, RankingEntry, RankingTotal } from '../../types/gurushots';

const closeLine = (challenge: Challenge, now: number): string | null => {
    const close = Number(challenge?.close_time);
    if (!Number.isFinite(close)) return null;
    return `  Closes in ${formatDuration(close - now)}`;
};

const exposureLine = (exposureFactor: number | null | undefined): string => {
    const exposure = finiteOr(exposureFactor, null);
    return `  Exposure: ${exposure === null ? '—' : `${exposure}%`}`;
};

/**
 * The turbo line: the state and mode as the API reported them (none reported
 * reads as "none"; a mode that is not a game the bot can play reads as
 * "unknown" — see isKnownTurboMode), then the command that can run now: the
 * mini-game while one can be played (the shared canPlayTurbo), or, on a WON
 * turbo, the apply command — its photo id comes from the detail view's entry
 * list.
 */
const turboLine = (challenge: Challenge, id: string, now: number): string => {
    const turbo: MemberTurbo | null | undefined = challenge?.member?.turbo;
    const state = turbo?.state ? stripTerminalControl(turbo.state) : 'none';
    const mode = isKnownTurboMode(turbo) ? stripTerminalControl(turbo?.mode) : 'unknown';
    const base = `  Turbo: ${state} (mode ${mode})`;
    if (canPlayTurbo(challenge, now)) return `${base} — can play now: turbo --challenge=${id}`;
    if (turbo?.state === 'WON') return `${base} — apply it to a photo: turbo --challenge=${id} --image=<photo id>`;
    return base;
};

const rankLine = (total: RankingTotal | null | undefined): string | null => {
    const tail = total ? rankingTail(total) : null;
    return tail === null ? null : `  Rank: ${tail}`;
};

/** One entry of the detail view: its id (what `--image=<id>` aims at), its votes and rank, and a boost/turbo already on it. */
const entryLine = (entry: RankingEntry): string => {
    const marks = [entry.boosted === true ? 'boosted' : null, entry.turbo === true ? 'turboed' : null]
        .filter((mark) => mark !== null)
        .join(', ');
    const stats = [
        finiteOr(entry.votes, null) === null ? null : `${entry.votes} votes`,
        isInteger(entry.rank) && entry.rank > 0 ? `rank ${entry.rank}` : null,
    ]
        .filter((part) => part !== null)
        .join(', ');
    return `    • ${stripTerminalControl(entry.id)}${stats === '' ? '' : ` — ${stats}`}${marks === '' ? '' : ` (${marks})`}`;
};

/**
 * One challenge's block. A marked challenge's fields are the ones the
 * boundary refused to read, so — like status's Standing section — it names the
 * challenge and stops at "(data cannot be read)".
 */
const challengeBlock = (challenge: Challenge, now: number): string[] => {
    const id = stripTerminalControl(challenge?.id);
    const title = stripTerminalControl(challenge?.title);
    if (isMarkedChallenge(challenge)) return [`• ${id} — ${title} — (data cannot be read)`];

    const member = challenge.member;
    const lines = [
        `• ${id} — ${title}`,
        closeLine(challenge, now),
        `  Entries: ${(member?.ranking?.entries ?? []).length} / ${challenge.max_photo_submits || 0}`,
        exposureLine(member?.ranking?.exposure?.exposure_factor),
        `  Boost: ${member?.boost?.state ? stripTerminalControl(member.boost.state) : 'none'}`,
        turboLine(challenge, id, now),
        rankLine(member?.ranking?.total),
    ];
    return lines.filter((line): line is string => line !== null);
};

/**
 * The `challenges` command. With `detailId` (from `--challenge=<id>`) it prints
 * one challenge's block plus its entries — the photo ids a `--image=<id>`
 * aims at; without, one block per active challenge. Returns false on a failed
 * fetch, an unknown id, or being unauthenticated (exit 1).
 */
const challengesCmd = async (detailId: string | null): Promise<boolean> => {
    if (!ensureAuthenticated()) return false;

    let challenges: Challenge[];
    try {
        const resp = await getMiddleware().getActiveChallenges();
        challenges = Array.isArray(resp?.challenges) ? resp.challenges : [];
    } catch (err) {
        logger
            .withCategory('challenges')
            .error(
                `Failed to fetch the active challenges: ${errorMessage(err) || err}. Nothing was read — check the connection and try again.`,
            );
        return false;
    }

    const now = Math.floor(Date.now() / 1000);
    if (detailId !== null) {
        const challenge = findActiveChallenge(challenges, detailId);
        if (!challenge) {
            logger.withCategory('challenges').error(`Challenge ${detailId} not found among active challenges`);
            return false;
        }
        const block = challengeBlock(challenge, now);
        const entries = challenge.member?.ranking?.entries ?? [];
        for (const line of entries.length === 0 ? block : [...block, '  Entries:', ...entries.map(entryLine)]) {
            logger.withCategory('challenges').info(line);
        }
        return true;
    }

    if (challenges.length === 0) {
        logger.withCategory('challenges').info('No active challenges.');
        return true;
    }
    for (const challenge of challenges) {
        for (const line of challengeBlock(challenge, now)) logger.withCategory('challenges').info(line);
    }
    return true;
};

export { challengesCmd, challengeBlock, turboLine, entryLine };
