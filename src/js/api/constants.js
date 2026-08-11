/**
 * GuruShots API constants — base URLs, endpoint paths, and shared
 * content types. Single source so the mobile and web header profiles
 * stay aligned across api-client, login, voting, boost, turbo,
 * submissions, and challenges modules.
 */

const API_BASE = 'https://api.gurushots.com';

// rest_mobile/* endpoints share the iOS-spoof header profile assembled
// in randomizer.js. rest/* endpoints use the WEB profile (x-env: WEB,
// x-api-version: 13) built by createWebHeaders below and shared by
// turbo.js / submissions.js.
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
    imageData: `${API_BASE}/rest/get_image_data`,
    submitToChallenge: `${API_BASE}/rest/submit_to_challenge`,
};

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=utf-8';

// WEB header profile for the /rest/ endpoints (turbo + submissions flows).
// The session token sent via x-token works the same as the mobile flow.
const createWebHeaders = (token) => ({
    host: 'api.gurushots.com',
    accept: '*/*',
    'content-type': FORM_CONTENT_TYPE,
    'x-api-version': '13',
    'x-env': 'WEB',
    'x-requested-with': 'XMLHttpRequest',
    'x-token': token,
});

// Builds a module-scoped required-argument guard whose thrown message is
// prefixed with the calling module's name (e.g. 'turbo: token is required').
const makeRequireValue = (prefix) => (value, label) => {
    if (value === null || value === undefined || value === '') {
        throw new Error(`${prefix}: ${label} is required`);
    }
    return value;
};

module.exports = {
    API_BASE,
    ENDPOINTS,
    FORM_CONTENT_TYPE,
    createWebHeaders,
    makeRequireValue,
};
