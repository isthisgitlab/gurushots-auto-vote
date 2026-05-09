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
const cancellation = require('../voting/cancellation');
const { submitVotesForChallenge } = require('./manualVote');

const STAGGER_MS = 1000;

const requireToken = () => {
    const token = settings.getSetting('token');
    if (!token) throw new Error('No authentication token found');
    return token;
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

    async _runVote(challengeId = null) {
        const token = settings.getSetting('token');
        if (!token) {
            return { ok: false, error: 'No authentication token found. Please login first.' };
        }
        const result = await this.apiStrategy.fetchChallengesAndVote(
            token,
            settings.getExposureResolver(),
            challengeId,
        );
        return { ok: true, result };
    }

    /**
     * IPC-shaped voting cycle entry. Resets cancellation state, runs the
     * strategy, and returns `{ success, message } | { success: false, error }`
     * matching what the renderer expects. `challengeId` is optional; null/undefined
     * means run the full active set.
     */
    async runVotingCycle(challengeId = null) {
        cancellation.reset();
        const { ok, error, result } = await this._runVote(challengeId);
        if (!ok) {
            logger.withCategory('authentication').warning(`❌ ${error}`, null);
            return { success: false, error };
        }
        if (result && result.success) {
            return { success: true, message: result.message || 'Voting cycle completed successfully' };
        }
        return { success: false, error: result?.error || 'Voting cycle failed' };
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
            await this.apiStrategy.fetchChallengesAndVote(token, settings.getExposureResolver(), challengeId);
            logger.withCategory('voting').endOperation('cli-vote', 'Voting process completed successfully');
        } catch (error) {
            logger.withCategory('voting').endOperation('cli-vote', null, error.message || error);
        }
    }

    /**
     * Manual voting cycle for the CLI: vote every active challenge to 100%
     * regardless of threshold settings. Mirrors the IPC handler's
     * `vote-all-challenges-manual` mechanic — both routes share
     * `submitVotesForChallenge` so eligibility + image fetch + submit lives
     * in one place. Successful votes are spaced by `STAGGER_MS` to honor
     * the per-cycle stagger contract (don't batch submissions).
     */
    async cliVoteManual() {
        logger.withCategory('voting').info('=== GuruShots Auto Voter - CLI Manual Voting (vote-to-100%) ===', null);
        const token = settings.getSetting('token');
        if (!token) {
            logger.withCategory('authentication').error('No authentication token found. Please login first', null);
            logger.withCategory('authentication').info('Run the login command to authenticate', null);
            return;
        }
        logger.withCategory('voting').startOperation('cli-vote-manual', 'CLI Manual Voting Process');
        try {
            const challengesResponse = await this.apiStrategy.getActiveChallenges(token);
            if (!challengesResponse || !challengesResponse.challenges) {
                logger.withCategory('challenges').warning('Failed to fetch challenges for manual voting', null);
                logger.withCategory('voting').endOperation('cli-vote-manual', null, 'failed to fetch challenges');
                return;
            }
            const challenges = challengesResponse.challenges;
            const now = Math.floor(Date.now() / 1000);
            let voted = 0;
            let skipped = 0;
            for (const challenge of challenges) {
                try {
                    const result = await submitVotesForChallenge(challenge, this.apiStrategy, token, now);
                    if (result.outcome === 'voted') {
                        voted++;
                        logger
                            .withCategory('voting')
                            .success(
                                `Voted on challenge: ${challenge.title} (target: ${result.targetExposure}%)`,
                                null,
                            );
                        await new Promise((resolve) => setTimeout(resolve, STAGGER_MS));
                    } else if (result.outcome === 'no-images') {
                        skipped++;
                        logger.withCategory('voting').warning(`No vote images available for: ${challenge.title}`, null);
                    } else {
                        skipped++;
                        logger
                            .withCategory('voting')
                            .info(`Skipping ${challenge.title} - ${result.errorMessage}`, null);
                    }
                } catch (error) {
                    skipped++;
                    logger.withCategory('voting').error(`Error voting on challenge ${challenge.title}:`, error);
                }
            }
            const summary = `Manual vote: ${voted} voted, ${skipped} skipped of ${challenges.length}`;
            logger.withCategory('voting').endOperation('cli-vote-manual', summary);
        } catch (error) {
            logger.withCategory('voting').endOperation('cli-vote-manual', null, error.message || error);
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
