/**
 * GuruShots Auto Voter - Middleware Layer
 * 
 * This module provides a unified interface for both CLI and GUI usage.
 * It handles token management, settings integration, and provides
 * the appropriate interface based on the context.
 */

const settings = require('../settings');
const { authenticate } = require('./login');
const { fetchChallengesAndVote } = require('./main');
const { getActiveChallenges } = require('./challenges');
const { getVoteImages, submitVotes } = require('./voting');
const { applyBoost } = require('./boost');

/**
 * CLI-specific login function with user prompts
 * 
 * @returns {object|null} - Login response or null if failed
 */
const cliLogin = async () => {
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
        // Attempt authentication
        const response = await authenticate(email, password);
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
};

/**
 * GUI-friendly login function
 * 
 * @param {string} email - User's email address
 * @param {string} password - User's password
 * @returns {object} - Object containing success status and data/error
 */
const guiLogin = async (email, password) => {
    try {
        const response = await authenticate(email, password);
        
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
};

/**
 * CLI-specific voting function
 * 
 * @returns {void}
 */
const cliVote = async () => {
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
        await fetchChallengesAndVote(token);
        console.log('Voting process completed successfully!');
    } catch (error) {
        console.error('Error during voting process:', error.message || error);
    }
};

/**
 * GUI-friendly voting function
 * 
 * @returns {object} - Object containing success status and data/error
 */
const guiVote = async () => {
    try {
        // Load token from settings
        const token = settings.getSetting('token');
        
        if (!token) {
            return {
                success: false,
                error: 'No authentication token found. Please login first.',
            };
        }
        
        await fetchChallengesAndVote(token);
        
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
};

/**
 * Check if user is authenticated
 * 
 * @returns {boolean} - True if user has a valid token
 */
const isAuthenticated = () => {
    const token = settings.getSetting('token');
    return !!(token && token.trim() !== '');
};

/**
 * Logout function (clears token from settings)
 * 
 * @param {boolean} clearToken - Whether to clear the token (default: true)
 */
const logout = (clearToken = true) => {
    if (clearToken) {
        settings.setSetting('token', '');
        console.log('Logged out successfully');
    }
};

module.exports = {
    // CLI interface
    cliLogin,
    cliVote,
    
    // GUI interface
    guiLogin,
    guiVote,
    
    // Utility functions
    isAuthenticated,
    logout,
    
    // Direct API access (for advanced usage)
    authenticate,
    fetchChallengesAndVote,
    getActiveChallenges,
    getVoteImages,
    submitVotes,
    applyBoost,
}; 