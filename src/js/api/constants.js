/**
 * GuruShots API constants — base URLs, endpoint paths, and shared
 * content types. Single source so the mobile and web header profiles
 * stay aligned across api-client, login, voting, boost, turbo,
 * submissions, and challenges modules.
 */

const API_BASE = 'https://api.gurushots.com';

// rest_mobile/* endpoints share the iOS-spoof header profile assembled
// in randomizer.js. rest/* endpoints use the WEB profile (x-env: WEB,
// x-api-version: 13) wired locally in turbo.js / submissions.js.
const ENDPOINTS = {
    signup: `${API_BASE}/rest_mobile/signup`,
    activeChallenges: `${API_BASE}/rest_mobile/get_my_active_challenges`,
    voteImages: `${API_BASE}/rest_mobile/get_vote_images`,
    submitVote: `${API_BASE}/rest_mobile/submit_vote`,
    boostPhoto: `${API_BASE}/rest_mobile/boost_photo`,

    challengeTurbo: `${API_BASE}/rest/get_challenge_turbo`,
    submitTurboSelection: `${API_BASE}/rest/submit_challenge_turbo_selection`,
    setTurbo: `${API_BASE}/rest/set_challenge_turbo`,
    photosPrivate: `${API_BASE}/rest/get_photos_private`,
    submitToChallenge: `${API_BASE}/rest/submit_to_challenge`,
};

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=utf-8';

module.exports = {
    API_BASE,
    ENDPOINTS,
    FORM_CONTENT_TYPE,
};
