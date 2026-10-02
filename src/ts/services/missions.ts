/**
 * Mission-aware automation. The main GuruShots mission slot rotates through
 * "Join N challenges", "Use Fill N times", "Win Turbo N times", "Vote on N
 * photos" and an all-star mission (nothing to automate there). get_my_missions
 * carries no type field, so a mission is recognised by the keyword in its
 * name; how many are still needed comes from its progress, never from the text.
 *
 * Read at the start of a voting cycle — only while one of the mission settings
 * is on — and handed to the join pre-step and the voting pass as a mutable
 * MissionNeeds. Each step that lands a join, a fill or a turbo win counts it
 * down (consumeMission), so the rest of the cycle doesn't overshoot on the
 * progress the server reported at its start. The headless Android pass also
 * refreshes progress before using a saved Turbo.
 *
 * A vote mission is spread over the challenges instead (missionVoteQuota): each
 * cycle every challenge that can take votes votes its share of what is left, up
 * to 100% exposure, without waiting for its threshold.
 */

import * as logger from '../logger';
import * as settings from '../settings';

import type { Challenge, Mission } from '../types/gurushots';
import { errorMessage } from '../errorMessage';

type MissionKind = 'join' | 'fill' | 'turbo' | 'vote';

/** How many actions active missions still need, with each Turbo need paired to its deadline.
 */
export type MissionNeeds = Record<MissionKind, number> & {
    turboRequirements?: Array<{ remaining: number; expiresAtSec: number | null }>;
};

const MISSION_KEYWORDS: ReadonlyArray<[MissionKind, RegExp]> = [
    ['turbo', /\bturbo/i],
    ['fill', /\b(?:auto)?fills?\b/i],
    ['join', /\bjoin\b/i],
    // "Vote on 400 photos" — not "Fulfill 3 votes", "Get 500 votes" or "Receive a vote for your photo".
    ['vote', /\bvote\s+(?:on|for)\s+(?:\d[\d.,\s]*\s)?photos?\b/i],
];

// The all-star mission can't be automated, and its wording may well mention
// joining — never let it read as a join (or fill) mission.
const ALL_STAR = /all.?star/i;

// The settings that follow each mission kind. Joining early serves a turbo
// mission too: a turbo is only winnable in a joined challenge.
const MISSION_SETTINGS: Readonly<
    Record<MissionKind, ReadonlyArray<'missionJoinEarly' | 'missionUseFills' | 'missionSaveTurbos' | 'missionVote'>>
> = Object.freeze({
    join: ['missionJoinEarly'],
    fill: ['missionUseFills'],
    turbo: ['missionSaveTurbos', 'missionJoinEarly'],
    vote: ['missionVote'],
});

const CLAIMABLE = 'CLAIM';

const cat = () => logger.withCategory('missions');

// The last summary logged, so an unchanged mission state isn't repeated every cycle.
let lastSummary = '';

// Mission needs of each in-flight voting pass, per account token, ref-counted.
const activeNeedsByToken = new Map<string, Map<MissionNeeds, number>>();

const classifyMission = (mission: Mission): MissionKind | null => {
    const text = `${mission?.name ?? ''} ${mission?.description ?? ''}`;
    if (ALL_STAR.test(text)) return null;
    const match = MISSION_KEYWORDS.find(([, pattern]) => pattern.test(text));
    return match ? match[0] : null;
};

/**
 * What the mission still needs: 0 once it is complete (claimable) or expired.
 */
const remainingOf = (mission: Mission, nowSec: number): number => {
    if (mission?.claim_state === CLAIMABLE) return 0;
    const expires = Number(mission?.expiration_timestamp);
    if (Number.isFinite(expires) && expires > 0 && expires <= nowSec) return 0;
    const left = Number(mission?.progress?.required) - Number(mission?.progress?.current);
    return Number.isFinite(left) && left > 0 ? left : 0;
};

const logNeeds = (needs: MissionNeeds) => {
    const active = (Object.keys(MISSION_SETTINGS) as MissionKind[]).filter((kind) => needs[kind] > 0);
    const summary = active.map((kind) => `${kind} ${needs[kind]} to go`).join(', ');
    if (summary === lastSummary) return;
    lastSummary = summary;
    cat().info(summary ? `🎯 Active missions: ${summary}` : 'No automatable mission active', null);
};

const readMissionNeeds = async (
    token: string,
    nowMs: number,
    getMyMissions: (token: string) => Promise<Mission[]>,
): Promise<MissionNeeds | null> => {
    const kinds = Object.keys(MISSION_SETTINGS) as MissionKind[];
    const enabled = kinds.filter((kind) =>
        MISSION_SETTINGS[kind].some((key) => settings.getEffectiveSetting(key, null) === true),
    );
    if (!token || enabled.length === 0) return null;
    const missions = await getMyMissions(token);
    const nowSec = Math.floor(nowMs / 1000);
    const needs: MissionNeeds = { join: 0, fill: 0, turbo: 0, vote: 0 };
    for (const mission of Array.isArray(missions) ? missions : []) {
        const kind = classifyMission(mission);
        if (!kind || !enabled.includes(kind)) continue;
        const remaining = remainingOf(mission, nowSec);
        needs[kind] = Math.max(needs[kind], remaining);
        if (kind !== 'turbo' || remaining <= 0) continue;
        const expires = Number(mission.expiration_timestamp);
        (needs.turboRequirements ??= []).push({
            remaining,
            expiresAtSec: Number.isFinite(expires) && expires > nowSec ? expires : null,
        });
    }
    logNeeds(needs);
    return needs;
};

/**
 * The active missions' needs for the kinds a setting on follows (the rest
 * stay 0), or null when every mission setting is off or the missions can't be read.
 * Never throws: like the join and claim pre-steps, it must not abort voting.
 *
 * @param nowMs epoch ms
 */
const loadMissionNeeds = async (
    token: string,
    nowMs: number,
    { getMyMissions }: { getMyMissions: (token: string) => Promise<Mission[]> },
): Promise<MissionNeeds | null> => {
    try {
        return await readMissionNeeds(token, nowMs, getMyMissions);
    } catch (error) {
        cat().warning(`could not read missions: ${errorMessage(error) || error}`, null);
        return null;
    }
};

/**
 * Whether a vote mission may spend votes here: a started, still open, non-flash
 * challenge below 100% exposure. Fully optional-chained, so a malformed
 * challenge reads as "no" instead of throwing.
 *
 * @param nowSec epoch seconds
 */
const isMissionVoteCandidate = (challenge: Challenge, nowSec: number): boolean => {
    if (challenge?.type === 'flash') return false;
    if (!(challenge?.start_time < nowSec) || !(challenge?.close_time > nowSec)) return false;
    return (challenge?.member?.ranking?.exposure?.exposure_factor ?? 0) < 100;
};

/**
 * How many photos each eligible challenge votes on this cycle: what the vote
 * mission still needs, split evenly over the challenges that can take votes
 * (rounded up), or 0 when none can or nothing is needed. `takesNoMissionVote`
 * (a challenge that is blocked, or that the normal rules already vote on) is
 * asked last, and a throw from it makes that challenge ineligible, so one
 * malformed challenge can't abort the pass.
 *
 * @param nowSec epoch seconds
 */
const missionVoteQuota = (
    remaining: number,
    challenges: Challenge[],
    nowSec: number,
    takesNoMissionVote: (challenge: Challenge) => boolean,
): number => {
    if (!(remaining > 0)) return 0;
    const eligible = challenges.filter((challenge) => {
        if (!isMissionVoteCandidate(challenge, nowSec)) return false;
        try {
            return !takesNoMissionVote(challenge);
        } catch {
            return false;
        }
    });
    return eligible.length > 0 ? Math.ceil(remaining / eligible.length) : 0;
};

/**
 * Count one landed join / fill / turbo win against the mission.
 */
const consumeMission = (needs: MissionNeeds | null | undefined, kind: MissionKind) => {
    if (needs && needs[kind] > 0) needs[kind] -= 1;
};

const registerMissionNeeds = (token: string, needs: MissionNeeds | null): (() => void) | null => {
    if (!needs) return null;
    const active = activeNeedsByToken.get(token) ?? new Map<MissionNeeds, number>();
    active.set(needs, (active.get(needs) ?? 0) + 1);
    activeNeedsByToken.set(token, active);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const owners = active.get(needs)!;
        if (owners > 1) active.set(needs, owners - 1);
        else active.delete(needs);
        if (active.size === 0) activeNeedsByToken.delete(token);
    };
};

const recordManualTurboWin = (token: string): void => {
    for (const needs of activeNeedsByToken.get(token)?.keys() ?? []) consumeMission(needs, 'turbo');
};

// Test hook: forget the last logged summary.
const resetMissionLog = () => {
    lastSummary = '';
};

export {
    classifyMission,
    loadMissionNeeds,
    consumeMission,
    isMissionVoteCandidate,
    missionVoteQuota,
    registerMissionNeeds,
    recordManualTurboWin,
    resetMissionLog,
};
