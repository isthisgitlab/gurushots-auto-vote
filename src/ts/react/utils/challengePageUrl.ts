// aislop-ignore-next-line ai-slop/hardcoded-url -- stable public GuruShots pages, not a deployment URL
const CHALLENGES_URL = 'https://gurushots.com/challenges';
const CHALLENGE_URL_PREFIX = 'https://gurushots.com/challenge/';
const SLUG = /^[\w-]+$/;

/**
 * The GuruShots page of a challenge. `slug` is the API's `challenge.url`, interpolated into a URL path, so only
 * word characters and hyphens are accepted; any other value (a path walk, a `?`, a `#`, another host) gets the
 * generic challenges page rather than an attacker-shaped URL.
 *
 * @param slug - challenge.url
 */
export const challengePageUrl = (slug: string | null | undefined): string =>
    typeof slug === 'string' && SLUG.test(slug) ? `${CHALLENGE_URL_PREFIX}${slug}` : CHALLENGES_URL;
