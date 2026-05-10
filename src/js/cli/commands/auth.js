/**
 * CLI auth commands. Currently just `login` — interactive credential
 * prompt that mutes the password echo and refuses non-TTY invocation
 * (piped stdin would let the password through unmuted).
 */

const logger = require('../../logger');
const settings = require('../../settings');
const { refreshApi, getMiddleware } = require('../../apiFactory');
const { createReadlineInterface, askYesNo, askInput, askSecret } = require('../prompts');

const handleLogin = async () => {
    // askSecret's mute only works on a real terminal — _writeToOutput is
    // bypassed when stdin is piped or when readline runs in non-terminal
    // mode. Refuse interactive login in that case so a user piping
    // `echo password | node cli.js login` does not get a false sense of
    // protection (the password would echo through the unmuted path).
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        logger
            .withCategory('ui')
            .error(
                'Interactive login requires a terminal. Run `node src/js/cli/cli.js login` directly in a terminal session — piped or redirected stdin is not supported because the password prompt cannot mute echo.',
            );
        return;
    }

    const rl = createReadlineInterface();

    try {
        logger.withCategory('ui').info('=== GuruShots Auto Voter - Login ===');

        const userSettings = settings.loadSettings();
        const currentMockMode = userSettings.mock;

        logger.withCategory('ui').info(`Current mode: ${currentMockMode ? 'MOCK' : 'REAL'}`);

        const changeMode = await askYesNo('Do you want to change the mode?', rl);

        let useMockMode = currentMockMode;

        if (changeMode) {
            logger.withCategory('ui').info('Mode options:');
            logger.withCategory('ui').info('  REAL  - Connect to actual GuruShots API (production)');
            logger.withCategory('ui').info('  MOCK  - Simulate API calls for testing (development)');

            const useMock = await askYesNo('Use MOCK mode?', rl);
            useMockMode = useMock;

            settings.setSetting('mock', useMockMode);
            logger.withCategory('settings').success(`Mode changed to: ${useMockMode ? 'MOCK' : 'REAL'}`);
        }

        const email = await askInput('\nEnter your GuruShots email: ', rl);
        const password = await askSecret('Enter your GuruShots password: ', rl);

        logger.withCategory('authentication').startOperation('login-auth', 'Authenticating with GuruShots');

        // Pick up the freshly-set mock flag (if changed above) before
        // grabbing the middleware instance.
        refreshApi();
        const middleware = getMiddleware();

        const loginResult = await middleware.cliLogin(email, password);

        if (loginResult.success) {
            logger.withCategory('authentication').endOperation('login-auth', 'Login successful');
            logger.withCategory('authentication').success(`Token saved for ${useMockMode ? 'MOCK' : 'REAL'} mode`);
        } else {
            logger
                .withCategory('authentication')
                .endOperation('login-auth', null, loginResult.error || 'Unknown error');
        }
    } catch (error) {
        logger.withCategory('authentication').error('Login error', error);
    } finally {
        rl.close();
    }
};

module.exports = { handleLogin };
