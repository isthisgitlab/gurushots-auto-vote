/**
 * GuruShots Auto Voter - Mock Middleware
 * 
 * This module provides mock implementations of the API middleware
 * for testing and development purposes.
 */

const settings = require('../settings');
const { mockApiClient } = require('./index');

/**
 * Mock CLI login function
 * 
 * @returns {object|null} - Login response or null if failed
 */
const mockCliLogin = async () => {
    console.log('=== GuruShots Auto Voter - Mock CLI Login ===');
    console.log('Using mock authentication...');
    
    // Simulate loading animation
    const loading = setInterval(() => {
        process.stdout.write('\rLogging in... ');
    }, 300);
    
    try {
        // Use mock API client for authentication
        const response = await mockApiClient.authenticate('test@example.com', 'password');
        clearInterval(loading);
        
        console.log('\nLogin successful!');
        console.log('Mock token obtained successfully');
        
        // Save mock token to settings
        settings.setSetting('token', response.token);
        console.log('Mock token saved to settings');
        
        return response;
    } catch (error) {
        clearInterval(loading);
        console.log('\nLogin failed:', error.message);
        return null;
    }
};

/**
 * Mock GUI login function
 * 
 * @param {string} email - User's email address
 * @param {string} password - User's password
 * @returns {object} - Object containing success status and data/error
 */
const mockGuiLogin = async (email, password) => {
    try {
        const response = await mockApiClient.authenticate(email, password);
        
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
 * Mock CLI voting function
 * 
 * @returns {void}
 */
const mockCliVote = async () => {
    console.log('=== GuruShots Auto Voter - Mock CLI Voting ===');
    
    // Load token from settings
    const token = settings.getSetting('token');
    
    if (!token) {
        console.error('No authentication token found. Please login first.');
        console.log('Run the login command to authenticate.');
        return;
    }
    
    console.log('Starting mock voting process...');
    
    try {
        // Get mock active challenges
        const challengesResponse = await mockApiClient.getActiveChallenges(token);
        const { challenges } = challengesResponse;
        
        console.log(`Found ${challenges.length} active challenges`);
        
        // Process each challenge
        for (const challenge of challenges) {
            console.log(`Processing challenge: ${challenge.title}`);
            
            // Check if boost is available
            const { boost } = challenge.member;
            if (boost.state === 'AVAILABLE' && boost.timeout) {
                console.log(`Boost available for challenge: ${challenge.title}`);
                
                // Apply mock boost
                try {
                    await mockApiClient.applyBoost(challenge, token);
                    console.log(`Mock boost applied to challenge: ${challenge.title}`);
                } catch (error) {
                    console.error(`Mock boost failed for challenge: ${challenge.title}:`, error.message);
                }
            }
            
            // Vote on challenge if exposure factor is less than 100
            if (challenge.member.ranking.exposure.exposure_factor < 100) {
                try {
                    // Get mock vote images
                    const voteImages = await mockApiClient.getVoteImages(challenge, token);
                    if (voteImages && voteImages.images.length > 0) {
                        // Submit mock votes
                        await mockApiClient.submitVotes(voteImages, token);
                        console.log(`Mock votes submitted for challenge: ${challenge.title}`);
                        
                        // Simulate delay between challenges
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                } catch (error) {
                    console.error(`Mock voting failed for challenge: ${challenge.title}:`, error.message);
                }
            } else {
                console.log(`Challenge ${challenge.title} already has 100% exposure factor`);
            }
        }
        
        console.log('Mock voting process completed successfully!');
    } catch (error) {
        console.error('Error during mock voting process:', error.message);
    }
};

/**
 * Mock GUI voting function
 * 
 * @returns {object} - Object containing success status and data/error
 */
const mockGuiVote = async () => {
    try {
        // Load token from settings
        const token = settings.getSetting('token');
        
        if (!token) {
            return {
                success: false,
                error: 'No authentication token found. Please login first.',
            };
        }
        
        // Get challenges data for display
        const challengesResponse = await mockApiClient.getActiveChallenges(token);
        const { challenges } = challengesResponse;
        
        // Return challenges data for GUI display
        return {
            success: true,
            data: {
                challenges: challenges,
                message: `Loaded ${challenges.length} challenges for display`,
            },
        };
    } catch (error) {
        return {
            success: false,
            error: error.message || 'Mock voting process failed',
        };
    }
};

/**
 * Check if user is authenticated (works with mock tokens)
 * 
 * @returns {boolean} - True if user has a valid token
 */
const mockIsAuthenticated = () => {
    const token = settings.getSetting('token');
    return !!(token && token.trim() !== '');
};

/**
 * Mock logout function
 * 
 * @param {boolean} clearToken - Whether to clear the token (default: true)
 */
const mockLogout = (clearToken = true) => {
    if (clearToken) {
        settings.setSetting('token', '');
        console.log('Mock logged out successfully');
    }
};

module.exports = {
    // Mock CLI interface
    mockCliLogin,
    mockCliVote,
    
    // Mock GUI interface
    mockGuiLogin,
    mockGuiVote,
    
    // Mock utility functions
    mockIsAuthenticated,
    mockLogout,
    
    // Mock API client access
    mockApiClient,
}; 