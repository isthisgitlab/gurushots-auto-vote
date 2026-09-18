/**
 * Contract test for the `get-settings-schema` IPC payload — the single hop the
 * settings modals depend on to know what sections exist and in what order.
 *
 * The renderer reads `groups` and `tiers` off this payload (via
 * react/api/useSettingsSchema.js) and bands one into the other. Nothing else
 * asserts the handler actually emits them, so dropping a key, misspelling it,
 * or forgetting to re-export SETTINGS_TIERS from the settings facade would
 * surface only as an unheaded settings modal at runtime — the renderer's
 * fallback path deliberately renders every group unbanded rather than crashing.
 */

jest.mock('../../src/js/settings');
jest.mock('../../src/js/apiFactory', () => ({
    refreshApi: jest.fn(),
    getApiStrategy: jest.fn(),
    getMiddleware: jest.fn(),
}));

const settings = require('../../src/js/settings');
const { buildHandlers } = require('../../src/js/ipc/settings.handlers');

const GROUPS = [
    { id: 'general', label: 'app.groupGeneral', tier: 'core' },
    { id: 'lastMinute', label: 'app.groupLastMinute', tier: 'overrides' },
];
const TIERS = [
    { id: 'core', label: 'app.tierCore' },
    { id: 'overrides', label: 'app.tierOverrides' },
];

describe('get-settings-schema payload', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        settings.SETTINGS_SCHEMA = {
            exposure: {
                type: 'number',
                default: 100,
                perChallenge: true,
                group: 'general',
                label: 'app.exposure',
                description: 'app.exposureDesc',
            },
        };
        settings.SETTINGS_GROUPS = GROUPS;
        settings.SETTINGS_TIERS = TIERS;
        settings.getGlobalDefault = jest.fn().mockReturnValue(100);
    });

    test('forwards groups and tiers to the renderer', async () => {
        const handlers = buildHandlers();

        const payload = await handlers['get-settings-schema']({});

        expect(payload.groups).toEqual(GROUPS);
        expect(payload.tiers).toEqual(TIERS);
    });

    // Every group's tier must name a real tier, or the renderer drops that
    // section into its trailing unlabelled band.
    test('every forwarded group names a forwarded tier', async () => {
        const handlers = buildHandlers();

        const payload = await handlers['get-settings-schema']({});

        const tierIds = new Set(payload.tiers.map((tier) => tier.id));
        expect(payload.groups.filter((group) => !tierIds.has(group.tier))).toEqual([]);
    });

    test('projects the per-setting display fields the modals render', async () => {
        const handlers = buildHandlers();

        const payload = await handlers['get-settings-schema']({});

        expect(payload.schema.exposure).toMatchObject({
            type: 'number',
            group: 'general',
            label: 'app.exposure',
            description: 'app.exposureDesc',
        });
        expect(payload.defaults.exposure).toBe(100);
    });

    // The renderer never gets an exception — it gets an empty schema and
    // renders no sections. Guard that contract alongside the happy path.
    test('returns an empty schema instead of throwing when the facade fails', async () => {
        settings.getGlobalDefault = jest.fn(() => {
            throw new Error('boom');
        });
        const handlers = buildHandlers();

        await expect(handlers['get-settings-schema']({})).resolves.toEqual({ schema: {}, defaults: {} });
    });
});
