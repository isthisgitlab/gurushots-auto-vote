/**
 * Mission-aware automation. The main GuruShots mission slot rotates through
 * "Join N challenges", "Use Fill N times", "Win Turbo N times" and an all-star
 * mission (nothing to automate there). get_my_missions carries no type field,
 * so a mission is recognised by the keyword in its name; how many are still
 * needed comes from its progress, never from the text.
 *
 * Read once per voting cycle — only while one of the mission settings is on —
 * and handed to the join pre-step and the voting pass as a mutable
 * MissionNeeds. Each step that lands a join, a fill or a turbo win counts it
 * down (consumeMission), so the rest of the cycle doesn't overshoot on the
 * progress the server reported at its start.
 */

import * as logger from '../logger';
import * as settings from '../settings';

import type { Mission } from '../types/gurushots';
import { errorMessage } from '../errorMessage';

type MissionKind = 'join' | 'fill' | 'turbo';

/** How many joins / fills / turbo wins the active missions still need.
 */
export type MissionNeeds = Record<MissionKind, number>;

const MISSION_KEYWORDS: ReadonlyArray<[MissionKind, RegExp]> = [
    ['turbo', /\bturbo/i],
    ['fill', /\b(?:auto)?fills?\b/i],
    ['join', /\bjoin\b/i],
];

// The all-star mission can't be automated, and its wording may well mention
// joining — never let it read as a join (or fill) mission.
const ALL_STAR = /all.?star/i;

// The settings that follow each mission kind. Joining early serves a turbo
// mission too: a turbo is only winnable in a joined challenge.
const MISSION_SETTINGS: Readonly<
    Record<MissionKind, ReadonlyArray<'missionJoinEarly' | 'missionUseFills' | 'missionSaveTurbos'>>
> = Object.freeze({
    join: ['missionJoinEarly'],
    fill: ['missionUseFills'],
    turbo: ['missionSaveTurbos', 'missionJoinEarly'],
});

const CLAIMABLE = 'CLAIM';

const cat = () => logger.withCategory('missions');

// The last summary logged, so an unchanged mission state isn't repeated every cycle.
let lastSummary = '';

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
    const active = (Object.keys(needs) as MissionKind[]).filter((kind) => needs[kind] > 0);
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
    const needs: MissionNeeds = { join: 0, fill: 0, turbo: 0 };
    for (const mission of Array.isArray(missions) ? missions : []) {
        const kind = classifyMission(mission);
        if (kind && enabled.includes(kind)) needs[kind] = Math.max(needs[kind], remainingOf(mission, nowSec));
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
 * Count one landed join / fill / turbo win against the mission.
 */
const consumeMission = (needs: MissionNeeds | null | undefined, kind: MissionKind) => {
    if (needs && needs[kind] > 0) needs[kind] -= 1;
};

// Test hook: forget the last logged summary.
const resetMissionLog = () => {
    lastSummary = '';
};

export { classifyMission, loadMissionNeeds, consumeMission, resetMissionLog };
