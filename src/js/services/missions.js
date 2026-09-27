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

/** @import { Mission } from '../types/gurushots' */

/** @typedef {'join'|'fill'|'turbo'} MissionKind */

/** How many joins / fills / turbo wins the active missions still need. @typedef {Record<MissionKind, number>} MissionNeeds */

/** @type {ReadonlyArray<[MissionKind, RegExp]>} */
const MISSION_KEYWORDS = [
    ['turbo', /\bturbo/i],
    ['fill', /\b(?:auto)?fills?\b/i],
    ['join', /\bjoin\b/i],
];

// The all-star mission can't be automated, and its wording may well mention
// joining — never let it read as a join (or fill) mission.
const ALL_STAR = /all.?star/i;

/** @type {Readonly<Record<MissionKind, 'missionJoinEarly'|'missionUseFills'|'missionSaveTurbos'>>} */
const MISSION_SETTING = Object.freeze({
    join: 'missionJoinEarly',
    fill: 'missionUseFills',
    turbo: 'missionSaveTurbos',
});

const CLAIMABLE = 'CLAIM';

const cat = () => logger.withCategory('missions');

// The last summary logged, so an unchanged mission state isn't repeated every cycle.
let lastSummary = '';

/**
 * @param {Mission} mission
 * @returns {MissionKind|null}
 */
const classifyMission = (mission) => {
    const text = `${mission?.name ?? ''} ${mission?.description ?? ''}`;
    if (ALL_STAR.test(text)) return null;
    const match = MISSION_KEYWORDS.find(([, pattern]) => pattern.test(text));
    return match ? match[0] : null;
};

/**
 * What the mission still needs: 0 once it is complete (claimable) or expired.
 *
 * @param {Mission} mission
 * @param {number} nowSec
 * @returns {number}
 */
const remainingOf = (mission, nowSec) => {
    if (mission?.claim_state === CLAIMABLE) return 0;
    const expires = Number(mission?.expiration_timestamp);
    if (Number.isFinite(expires) && expires > 0 && expires <= nowSec) return 0;
    const left = Number(mission?.progress?.required) - Number(mission?.progress?.current);
    return Number.isFinite(left) && left > 0 ? left : 0;
};

/** @param {MissionNeeds} needs */
const logNeeds = (needs) => {
    const active = /** @type {MissionKind[]} */ (Object.keys(needs)).filter((kind) => needs[kind] > 0);
    const summary = active.map((kind) => `${kind} ${needs[kind]} to go`).join(', ');
    if (summary === lastSummary) return;
    lastSummary = summary;
    cat().info(summary ? `🎯 Active missions: ${summary}` : 'No automatable mission active', null);
};

/**
 * @param {string} token
 * @param {number} nowMs
 * @param {(token: string) => Promise<Mission[]>} getMyMissions
 * @returns {Promise<MissionNeeds|null>}
 */
const readMissionNeeds = async (token, nowMs, getMyMissions) => {
    const kinds = /** @type {MissionKind[]} */ (Object.keys(MISSION_SETTING));
    const enabled = kinds.filter((kind) => settings.getEffectiveSetting(MISSION_SETTING[kind], null) === true);
    if (!token || enabled.length === 0) return null;
    const missions = await getMyMissions(token);
    const nowSec = Math.floor(nowMs / 1000);
    /** @type {MissionNeeds} */
    const needs = { join: 0, fill: 0, turbo: 0 };
    for (const mission of Array.isArray(missions) ? missions : []) {
        const kind = classifyMission(mission);
        if (kind && enabled.includes(kind)) needs[kind] = Math.max(needs[kind], remainingOf(mission, nowSec));
    }
    logNeeds(needs);
    return needs;
};

/**
 * The active missions' needs for the kinds whose setting is on (the rest stay
 * 0), or null when every mission setting is off or the missions can't be read.
 * Never throws: like the join and claim pre-steps, it must not abort voting.
 *
 * @param {string} token
 * @param {number} nowMs epoch ms
 * @param {{getMyMissions: (token: string) => Promise<Mission[]>}} deps
 * @returns {Promise<MissionNeeds|null>}
 */
const loadMissionNeeds = async (token, nowMs, { getMyMissions }) => {
    try {
        return await readMissionNeeds(token, nowMs, getMyMissions);
    } catch (error) {
        cat().warning(
            `could not read missions: ${/** @type {{ message?: unknown } | null | undefined} */ (error)?.message || error}`,
            null,
        );
        return null;
    }
};

/**
 * Count one landed join / fill / turbo win against the mission.
 *
 * @param {MissionNeeds|null|undefined} needs
 * @param {MissionKind} kind
 */
const consumeMission = (needs, kind) => {
    if (needs && needs[kind] > 0) needs[kind] -= 1;
};

// Test hook: forget the last logged summary.
const resetMissionLog = () => {
    lastSummary = '';
};

export { classifyMission, loadMissionNeeds, consumeMission, resetMissionLog };
