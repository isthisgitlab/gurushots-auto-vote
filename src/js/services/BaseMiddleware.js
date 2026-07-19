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
const { extractAuthResult } = require('./auth');
const { submitVotesForChallenge, STAGGER_MS } = require('./manualVote');

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
        // Token extraction is shared with the GUI IPC handler via
        // extractAuthResult so CLI and GUI accept the same token keys /
        // success indicators — historically _login only honoured `token`.
        const { ok, token } = extractAuthResult(response);
        if (ok) {
            settings.setSetting('token', token);
            return { ok: true, token, response };
        }
        return { ok: false, token: null, response };
    }

    async cliLogin(email, password) {
        logger.withCategory('authentication').info('=== GuruShots Auto Voter - CLI Login ===', null);
        logger.withCategory('authentication').startOperation('cli-login', 'CLI Authentication');
        try {
            const { ok, token } = await this._login(email, password);
            if (ok) {
                logger.withCategory('authentication').endOperation('cli-login', 'Authentication successful');
                logger.withCategory('authentication').success('Token obtained and saved to settings');
                return { success: true, token };
            }
            logger.withCategory('authentication').endOperation('cli-login', null, 'Invalid credentials');
            return { success: false, error: 'Login failed. Please check your credentials.' };
        } catch (error) {
            logger.withCategory('authentication').endOperation('cli-login', null, error.message || error);
            return { success: false, error: error.message || error };
        }
    }

    async guiLogin(email, password) {
        try {
            const { ok, token, response } = await this._login(email, password);
            if (ok) return { success: true, token, data: response };
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
            // Surface the fetched challenge list so the renderer's threshold
            // scheduler can reuse it instead of issuing a second IPC fetch.
            return {
                success: true,
                message: result.message || 'Voting cycle completed successfully',
                challenges: result.challenges,
            };
        }
        // Forward the list even on a non-error failure (cancelled / inactive
        // filtered challenge) so the contract matches main.js; consumers still
        // guard with Array.isArray and fall back to fetching when it's absent.
        return { success: false, error: result?.error || 'Voting cycle failed', challenges: result?.challenges };
    }

    /**
     * Token-or-null helper for CLI voting paths. Logs the standard
     * "please login first" pair under authentication when missing so
     * cliVote and cliVoteManual share one error surface.
     */
    _requireCliToken() {
        const token = settings.getSetting('token');
        if (!token) {
            logger.withCategory('authentication').error('No authentication token found. Please login first', null);
            logger.withCategory('authentication').info('Run the login command to authenticate', null);
            return null;
        }
        return token;
    }

    async cliVote(challengeId = null) {
        const scopeLabel = challengeId == null ? '' : ` (challenge ${challengeId})`;
        logger.withCategory('voting').info(`=== GuruShots Auto Voter - CLI Voting${scopeLabel} ===`, null);
        const token = this._requireCliToken();
        if (!token) return { success: false, error: 'No authentication token found' };
        logger.withCategory('voting').startOperation('cli-vote', `CLI Voting Process${scopeLabel}`);
        try {
            // Return the strategy result so the scheduler can reuse its
            // already-fetched challenge list for threshold scheduling instead
            // of issuing a second getActiveChallenges request.
            const result = await this.apiStrategy.fetchChallengesAndVote(
                token,
                settings.getExposureResolver(),
                challengeId,
            );
            // Reflect the actual outcome in the operation log — a non-error
            // failure (e.g. cancelled, or a filtered challenge that isn't active)
            // must not be reported as a success.
            if (result && result.success === false) {
                logger
                    .withCategory('voting')
                    .endOperation(
                        'cli-vote',
                        null,
                        result.error || result.message || 'Voting process did not complete',
                    );
            } else {
                logger.withCategory('voting').endOperation('cli-vote', 'Voting process completed successfully');
            }
            return result;
        } catch (error) {
            logger.withCategory('voting').endOperation('cli-vote', null, error.message || error);
            return { success: false, error: error.message || String(error) };
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
        const token = this._requireCliToken();
        if (!token) return;
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
                        await new Promise((resolve) => {
                            setTimeout(resolve, STAGGER_MS);
                        });
                    } else if (result.outcome === 'no-images') {
                        skipped++;
                        logger
                            .withCategory('voting')
                            .warning(`${logger.challengeTag(challenge)} No vote images available`, null);
                    } else {
                        skipped++;
                        logger
                            .withCategory('voting')
                            .info(`${logger.challengeTag(challenge)} Skipping - ${result.errorMessage}`, null);
                    }
                } catch (error) {
                    skipped++;
                    logger.withCategory('voting').error(`${logger.challengeTag(challenge)} Error voting:`, error);
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
