/**
 * Mock counterpart to api/tags.js: the member identity read and tag
 * autocomplete over the mock library's tags.
 */

const { simulateApiResponse, mockMethod } = require('../simulate');
const { MOCK_LIBRARY_TAGS } = require('../photoLibrary');

/**
 * Simulate /rest/get_current_member_profile — the token-only identity read
 * that supplies member_id for searchTagAutocomplete below.
 */
const getCurrentMemberProfile = mockMethod(
    {
        name: 'getCurrentMemberProfile',
        tokenArg: 0,
        onNoToken: () => null,
    },
    async () => {
        await simulateApiResponse({}, 150);
        return { id: 'mock_member_c1d1f773', userName: 'mockguru' };
    },
);

/**
 * Simulate /rest/search_autocomplete: SUBSTRING match over the tags the
 * mock library actually carries, capped like the live endpoint.
 *
 * The pairing with getEligiblePhotos (mock/endpoints/submissions.js) is the
 * point — that one matches a tag exactly, this one matches inside it — so
 * mock mode reproduces the real resolution problem: searching "flow" finds
 * no photos, autocomplete turns it into "flower", and THAT finds photos.
 */
const searchTagAutocomplete = mockMethod(
    {
        name: 'searchTagAutocomplete',
        tokenArg: 0,
        onNoToken: () => [],
    },
    async (token, term) => {
        await simulateApiResponse({}, 150);
        const text = typeof term === 'string' ? term.trim().toLowerCase() : '';
        // The live endpoint answers nothing under three characters.
        if (text.length < 3) return [];
        return MOCK_LIBRARY_TAGS.filter((tag) => tag.includes(text)).slice(0, 5);
    },
);

module.exports = { getCurrentMemberProfile, searchTagAutocomplete };
