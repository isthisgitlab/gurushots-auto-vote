/**
 * Shared test fixture builders.
 *
 * `buildChallenge(overrides)` returns the superset challenge shape the suites
 * exercise (id/title/close_time plus member.boost, member.turbo and
 * member.ranking with entries + exposure), deep-merging nested overrides so a
 * test only spells out what it cares about. Defaults are deliberately neutral
 * ('NONE' states, empty entries) — equivalent to the key being absent for
 * every code path under test.
 *
 * Suites keep their historical per-file defaults (ids, titles, time bases) as
 * tiny local wrappers around this builder, so what each test asserts is
 * unchanged.
 *
 * `buildSettingsFixture(overrides)` is the persisted-settings-file shape the
 * settings migration/sanitizer suites feed through loadSettings.
 *
 * NOTE: this directory is not picked up as a test suite — the Jest testMatch
 * patterns only match *(spec|test).js(x) filenames.
 */

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Deep-merge `overrides` onto `base`. Plain objects merge recursively;
 * arrays and scalars replace (same semantics as spread, one level at a time).
 * Keys explicitly present with `undefined` override the base value, matching
 * object-literal behavior in the original per-file builders.
 */
const deepMerge = (base, overrides) => {
    const result = { ...base };
    for (const key of Object.keys(overrides)) {
        const over = overrides[key];
        result[key] = isPlainObject(result[key]) && isPlainObject(over) ? deepMerge(result[key], over) : over;
    }
    return result;
};

const buildChallenge = (overrides = {}) =>
    deepMerge(
        {
            id: 'c1',
            title: 'Challenge',
            close_time: 1_000_000,
            member: {
                boost: { state: 'NONE', timeout: 0 },
                turbo: { state: 'NONE' },
                ranking: {
                    entries: [],
                    exposure: { exposure_factor: 50 },
                },
            },
        },
        overrides,
    );

const buildSettingsFixture = (overrides = {}) => ({
    challengeSettings: {
        globalDefaults: {},
        perChallenge: {},
        ...overrides,
    },
});

module.exports = { buildChallenge, buildSettingsFixture };
