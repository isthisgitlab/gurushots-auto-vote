/**
 * GuruShots Auto Voter - Timing Primitives
 *
 * Shared delay/timing helpers (sleep, randomized delays) used to make the
 * application behavior more human-like. Lives in the shared core — NOT in
 * api/ — so business logic (services, scheduling) can use it without
 * importing from the swappable API surface.
 */

/**
 * Creates a promise that resolves after the specified time
 *
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} - Promise that resolves after the specified time
 */
const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

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
