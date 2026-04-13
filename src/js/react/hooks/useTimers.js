import { useState, useEffect, useRef, useCallback } from 'react';
import { formatTimeRemaining } from '@/utils/formatters';

/**
 * Hook that manages countdown timers for challenges
 * Updates every second and returns formatted time remaining for each challenge
 * @param {Array} challenges - Array of challenge objects with close_time
 * @returns {Object} - Object mapping challengeId to formatted time string
 */
export function useTimers(challenges) {
    const [times, setTimes] = useState({});
    const intervalRef = useRef(null);

    // Calculate all times
    const updateTimes = useCallback(() => {
        if (!challenges || challenges.length === 0) {
            setTimes({});
            return;
        }

        const newTimes = {};
        for (const challenge of challenges) {
            newTimes[challenge.id] = formatTimeRemaining(challenge.close_time);
        }
        setTimes(newTimes);
    }, [challenges]);

    // Initial calculation and setup interval
    useEffect(() => {
        // Calculate immediately
        updateTimes();

        // Setup 1-second interval
        intervalRef.current = setInterval(updateTimes, 1000);

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
            }
        };
    }, [updateTimes]);

    return times;
}
