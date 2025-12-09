// Time and date formatting utilities

// Function to format time remaining
export const formatTimeRemaining = (endTime) => {
    const now = Math.floor(Date.now() / 1000);
    const remaining = endTime - now;

    if (remaining <= 0) {
        return 'Ended';
    }

    const days = Math.floor(remaining / 86400);
    const hours = Math.floor((remaining % 86400) / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    const seconds = Math.floor(remaining % 60);

    if (days > 0) {
        return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
        return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    } else {
        return `${seconds}s`;
    }
};

// Function to initialize timers for all challenge cards
export const initializeTimers = () => {
    // Clear any existing timers
    if (window.challengeTimers) {
        window.challengeTimers.forEach(timer => clearInterval(timer));
    }
    
    window.challengeTimers = [];
    
    // Find all time display elements
    const timeElements = document.querySelectorAll('[data-end-time]');
    
    timeElements.forEach(element => {
        const endTime = parseInt(element.getAttribute('data-end-time'));
        
        // Update immediately
        updateTimeElement(element, endTime);
        
        // Set interval to update every second
        const timerId = setInterval(() => {
            updateTimeElement(element, endTime);
        }, 1000);
        
        window.challengeTimers.push(timerId);
    });
};

// Helper function to update a single time element
const updateTimeElement = (element, endTime) => {
    const timeRemaining = formatTimeRemaining(endTime);
    element.textContent = timeRemaining;
    
    // Add appropriate color class
    if (timeRemaining === 'Ended') {
        element.classList.add('text-error');
        element.classList.remove('text-success');
    } else {
        element.classList.add('text-success');
        element.classList.remove('text-error');
    }
};

// Function to format end time
export const formatEndTime = (endTime, timezone = 'local') => {
    const date = new Date(endTime * 1000);

    const formatOptions = {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    };

    if (timezone === 'local') {
        return date.toLocaleString('lv-LV', formatOptions);
    } else {
        try {
            return date.toLocaleString('lv-LV', {
                ...formatOptions,
                timeZone: timezone,
            });
        } catch (error) {
            window.api.logWarning(`Error formatting date with timezone, falling back to local: ${error.message || error}`);
            return date.toLocaleString('lv-LV', formatOptions);
        }
    }
};

// Function to get boost status with color class
export const getBoostStatus = (boost) => {
    if (boost.state === 'AVAILABLE' || boost.state === 'AVAILABLE_KEY') {
        const now = Math.floor(Date.now() / 1000);
        const remaining = boost.timeout - now;
        if (remaining > 0) {
            const minutes = Math.floor(remaining / 60);
            return { text: `Available (${minutes}m left)`, colorClass: 'text-blue-500' };
        } else {
            return { text: 'Available', colorClass: 'text-blue-500' };
        }
    } else if (boost.state === 'USED') {
        return { text: 'Used', colorClass: 'text-green-500' };
    } else if (boost.state === 'UNAVAILABLE') {
        return { text: 'Unavailable', colorClass: 'text-red-500' };
    } else if (boost.state === 'LOCKED') {
        return { text: 'Locked', colorClass: 'text-red-500' };
    } else {
        return { text: boost.state || 'Unknown', colorClass: 'text-purple-500' };
    }
};

// Function to get turbo status with color class
export const getTurboStatus = (turbo) => {
    if (!turbo || !turbo.state) {
        return { text: 'Unavailable', colorClass: 'text-red-500' };
    }
    if (turbo.state === 'FREE') {
        return { text: 'Free', colorClass: 'text-blue-400' };
    } else if (turbo.state === 'TIMER') {
        return { text: 'Timer', colorClass: 'text-red-500' };
    } else if (turbo.state === 'IN_PROGRESS') {
        return { text: 'In Progress', colorClass: 'text-orange-500' };
    } else if (turbo.state === 'WON') {
        return { text: 'Won', colorClass: 'text-lime-800' };
    } else if (turbo.state === 'USED') {
        return { text: 'Used', colorClass: 'text-green-500' };
    } else if (turbo.state === 'UNAVAILABLE') {
        return { text: 'Unavailable', colorClass: 'text-red-500' };
    } else if (turbo.state === 'LOCKED') {
        return { text: 'Locked', colorClass: 'text-latvian' };
    } else {
        return { text: turbo.state || 'Unknown', colorClass: 'text-purple-500' };
    }
};

// Function to get level status with color class
export const getLevelStatus = (level, levelName) => {
    if (!level || !levelName) {
        return { text: 'Unknown', colorClass: 'badge-success' };
    }

    // Map level names to colors
    switch (levelName.toUpperCase()) {
    case 'POPULAR':
        return { text: `${levelName} ${level}`, colorClass: 'badge-popular' };
    case 'SKILLED':
        return { text: `${levelName} ${level}`, colorClass: 'badge-skilled' };
    case 'PREMIER':
        return { text: `${levelName} ${level}`, colorClass: 'badge-premier' };
    case 'ELITE':
        return { text: `${levelName} ${level}`, colorClass: 'badge-elite' };
    case 'ALL STAR':
        return { text: `${levelName} ${level}`, colorClass: 'badge-allstar' };
    default:
        return { text: `${levelName} ${level}`, colorClass: 'badge-warning' };
    }
};