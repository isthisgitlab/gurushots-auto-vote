/**
 * BaseMiddleware
 *
 * Wraps the active API surface (real or mock) with token handling
 * and exposes the same method names the renderer + CLI call into.
 * Common logic is shared between the cli/gui pairs via private
 * helpers; only logger category and return shape differ.
 */

const settings = require('../settings');
const logger = require('../logger');

const requireToken = () => {
    const token = settings.getSetting('token');
    if (!token) throw new Error('No authentication token found');
    return token;
};

const getExposureThresholdResolver = () => (challengeId) => {
    try {
        return settings.getEffectiveSetting('exposure', challengeId);
    } catch (error) {
        logger.withCategory('settings').warning(`Error getting exposure setting for challenge ${challengeId}`, error);
        return settings.SETTINGS_SCHEMA.exposure.default;
    }
};

class BaseMiddleware {
    constructor(apiStrategy) {
        this.apiStrategy = apiStrategy;
    }

    async _login(email, password) {
        const response = await this.apiStrategy.authenticate(email, password);
        if (response && response.token) {
            settings.setSetting('token', response.token);
            return { ok: true, response };
        }
        return { ok: false, response };
    }

    async cliLogin(email, password) {
        logger.withCategory('authentication').info('=== GuruShots Auto Voter - CLI Login ===', null);
        logger.withCategory('auth').startOperation('cli-login', 'CLI Authentication');
        try {
            const { ok, response } = await this._login(email, password);
            if (ok) {
                logger.withCategory('auth').endOperation('cli-login', 'Authentication successful');
                logger.withCategory('authentication').success('Token obtained and saved to settings');
                return { success: true, token: response.token };
            }
            logger.withCategory('auth').endOperation('cli-login', null, 'Invalid credentials');
            return { success: false, error: 'Login failed. Please check your credentials.' };
        } catch (error) {
            logger.withCategory('auth').endOperation('cli-login', null, error.message || error);
            return { success: false, error: error.message || error };
        }
    }

    async guiLogin(email, password) {
        try {
            const { ok, response } = await this._login(email, password);
            if (ok) return { success: true, data: response };
            return { success: false, error: 'Invalid credentials' };
        } catch (error) {
            return { success: false, error: error.message || 'Authentication failed' };
        }
    }

    async _runVote() {
        const token = settings.getSetting('token');
        if (!token) {
            return { ok: false, error: 'No authentication token found. Please login first.' };
        }
        await this.apiStrategy.fetchChallengesAndVote(token, getExposureThresholdResolver());
        return { ok: true };
    }

    async cliVote(challengeId = null) {
        const scopeLabel = challengeId == null ? '' : ` (challenge ${challengeId})`;
        logger.withCategory('voting').info(`=== GuruShots Auto Voter - CLI Voting${scopeLabel} ===`, null);
        const token = settings.getSetting('token');
        if (!token) {
            logger.withCategory('authentication').error('No authentication token found. Please login first', null);
            logger.withCategory('authentication').info('Run the login command to authenticate', null);
            return;
        }
        logger.withCategory('voting').startOperation('cli-vote', `CLI Voting Process${scopeLabel}`);
        try {
            await this.apiStrategy.fetchChallengesAndVote(token, getExposureThresholdResolver(), challengeId);
            logger.withCategory('voting').endOperation('cli-vote', 'Voting process completed successfully');
        } catch (error) {
            logger.withCategory('voting').endOperation('cli-vote', null, error.message || error);
        }
    }

    async guiVote() {
        const result = await this._runVote();
        if (!result.ok) return { success: false, error: result.error };
        return { success: true, data: 'Voting process completed successfully!' };
    }

    isAuthenticated() {
        const token = settings.getSetting('token');
        return !!(token && token.trim() !== '');
    }

    logout(clearToken = true) {
        if (clearToken) {
            settings.setSetting('token', '');
            logger.withCategory('authentication').success('Logged out successfully', null, null);
        }
    }

    getActiveChallenges() {
        return this.apiStrategy.getActiveChallenges(requireToken());
    }

    getVoteImages(challenge) {
        return this.apiStrategy.getVoteImages(challenge, requireToken());
    }

    submitVotes(voteImages, exposureThreshold = settings.SETTINGS_SCHEMA.exposure.default) {
        return this.apiStrategy.submitVotes(voteImages, requireToken(), exposureThreshold);
    }

    applyBoost(challenge) {
        return this.apiStrategy.applyBoost(challenge, requireToken());
    }

    applyBoostToEntry(challengeId, imageId) {
        return this.apiStrategy.applyBoostToEntry(challengeId, imageId, requireToken());
    }

    applyTurbo(challengeId, imageId) {
        return this.apiStrategy.applyTurbo(challengeId, imageId, requireToken());
    }
}

module.exports = BaseMiddleware;
