/**
 * GuruShots Auto Voter - Utility Functions
 *
 * This module contains utility functions for managing delays and timing
 * to make the application behavior more human-like.
 */

/**
 * Creates a promise that resolves after the specified time
 *
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} - Promise that resolves after the specified time
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generates a random delay between min and max milliseconds
 *
 * Used to add variability to request timing to appear more human-like
 *
 * @param {number} min - Minimum delay in milliseconds
 * @param {number} max - Maximum delay in milliseconds
 * @returns {number} - Random delay value
 */
const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

module.exports = {
    sleep,
    getRandomDelay,
}; 