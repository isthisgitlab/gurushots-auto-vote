/**
 * GuruShots Auto Voter - Base Middleware Service
 * 
 * This module provides common middleware functionality that can be used
 * by both real and mock API implementations, eliminating code duplication.
 */

const settings = require('../settings');

/**
 * Base middleware class that handles common functionality
 */
class BaseMiddleware {
    constructor(apiStrategy) {
        this.apiStrategy = apiStrategy;
    }

    /**
     * CLI-specific login function with user prompts
     * 
     * @returns {object|null} - Login response or null if failed
     */
    async cliLogin() {
        const prompt = require('prompt-sync')();
        
        console.log('=== GuruShots Auto Voter - CLI Login ===');
        
        // Prompt user for credentials
        const email = prompt('Please enter your email: ');
        const password = prompt('Please enter your password: ');

        // Create loading animation for better user experience
        const loading = (function () {
            const h = ['|', '/', '-', '\\']; // Animation characters
            let i = 0;

            return setInterval(() => {
                i = (i > 3) ? 0 : i;
                console.clear();
                console.log(`Logging in ${h[i]}`);
                i++;
            }, 300);
        })();

        try {
            // Attempt authentication using the provided strategy
            const response = await this.apiStrategy.authenticate(email, password);
            clearInterval(loading);
            
            if (response && response.token) {
                console.log('Login successful!');
                console.log('Token obtained successfully');
                
                // Save token to settings
                settings.setSetting('token', response.token);
                console.log('Token saved to settings');
                
                return response;
            } else {
                console.log('Login failed. Please check your credentials.');
                return null;
            }
        } catch (error) {
            clearInterval(loading);
            console.error('Login error:', error.message || error);
            return null;
        }
    }

    /**
     * GUI-friendly login function
     * 
     * @param {string} email - User's email address
     * @param {string} password - User's password
     * @returns {object} - Object containing success status and data/error
     */
    async guiLogin(email, password) {
        try {
            const response = await this.apiStrategy.authenticate(email, password);
            
            if (response && response.token) {
                // Save token to settings
                settings.setSetting('token', response.token);
                
                return {
                    success: true,
                    data: response,
                };
            } else {
                return {
                    success: false,
                    error: 'Invalid credentials',
                };
            }
        } catch (error) {
            return {
                success: false,
                error: error.message || 'Authentication failed',
            };
        }
    }

    /**
     * CLI-specific voting function
     * 
     * @returns {void}
     */
    async cliVote() {
        console.log('=== GuruShots Auto Voter - CLI Voting ===');
        
        // Load token from settings
        const token = settings.getSetting('token');
        
        if (!token) {
            console.error('No authentication token found. Please login first.');
            console.log('Run the login command to authenticate.');
            return;
        }
        
        console.log('Starting voting process...');
        
        try {
            await this.apiStrategy.fetchChallengesAndVote(token);
            console.log('Voting process completed successfully!');
        } catch (error) {
            console.error('Error during voting process:', error.message || error);
        }
    }

    /**
     * GUI-friendly voting function
     * 
     * @returns {object} - Object containing success status and data/error
     */
    async guiVote() {
        try {
            // Load token from settings
            const token = settings.getSetting('token');
            
            if (!token) {
                return {
                    success: false,
                    error: 'No authentication token found. Please login first.',
                };
            }
            
            await this.apiStrategy.fetchChallengesAndVote(token);
            
            return {
                success: true,
                data: 'Voting process completed successfully!',
            };
        } catch (error) {
            return {
                success: false,
                error: error.message || 'Voting process failed',
            };
        }
    }

    /**
     * Check if user is authenticated
     * 
     * @returns {boolean} - True if user has a valid token
     */
    isAuthenticated() {
        const token = settings.getSetting('token');
        return !!(token && token.trim() !== '');
    }

    /**
     * Logout function (clears token from settings)
     * 
     * @param {boolean} clearToken - Whether to clear the token (default: true)
     */
    logout(clearToken = true) {
        if (clearToken) {
            settings.setSetting('token', '');
            console.log('Logged out successfully');
        }
    }

    /**
     * Get active challenges using the strategy
     * 
     * @returns {object} - Challenges response
     */
    async getActiveChallenges() {
        const token = settings.getSetting('token');
        if (!token) {
            throw new Error('No authentication token found');
        }
        return this.apiStrategy.getActiveChallenges(token);
    }

    /**
     * Get vote images using the strategy
     * 
     * @param {object} challenge - Challenge object
     * @returns {object} - Vote images response
     */
    async getVoteImages(challenge) {
        const token = settings.getSetting('token');
        if (!token) {
            throw new Error('No authentication token found');
        }
        return this.apiStrategy.getVoteImages(challenge, token);
    }

    /**
     * Submit votes using the strategy
     * 
     * @param {object} voteImages - Vote images object
     * @param {number} exposureThreshold - Exposure threshold (default: schema default)
     * @returns {object} - Vote submission response
     */
    async submitVotes(voteImages, exposureThreshold = settings.SETTINGS_SCHEMA.exposure.default) {
        const token = settings.getSetting('token');
        if (!token) {
            throw new Error('No authentication token found');
        }
        return this.apiStrategy.submitVotes(voteImages, token, exposureThreshold);
    }

    /**
     * Apply boost using the strategy
     * 
     * @param {object} challenge - Challenge object
     * @returns {object} - Boost application response
     */
    async applyBoost(challenge) {
        const token = settings.getSetting('token');
        if (!token) {
            throw new Error('No authentication token found');
        }
        return this.apiStrategy.applyBoost(challenge, token);
    }

    /**
     * Apply boost to entry using the strategy
     * 
     * @param {string} challengeId - Challenge ID
     * @param {string} imageId - Image ID
     * @returns {object} - Boost application response
     */
    async applyBoostToEntry(challengeId, imageId) {
        const token = settings.getSetting('token');
        if (!token) {
            throw new Error('No authentication token found');
        }
        return this.apiStrategy.applyBoostToEntry(challengeId, imageId, token);
    }
}

module.exports = BaseMiddleware;