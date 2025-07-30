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
            console.warn('Error formatting date with timezone, falling back to local:', error);
            return date.toLocaleString('lv-LV', formatOptions);
        }
    }
};

// Function to get boost status
export const getBoostStatus = (boost) => {
    if (boost.state === 'AVAILABLE') {
        const now = Math.floor(Date.now() / 1000);
        const remaining = boost.timeout - now;
        if (remaining > 0) {
            const minutes = Math.floor(remaining / 60);
            return `Available (${minutes}m left)`;
        } else {
            return 'Available';
        }
    } else if (boost.state === 'USED') {
        return 'Used';
    } else {
        return 'Unavailable';
    }
};

// Function to get turbo status
export const getTurboStatus = (turbo) => {
    if (!turbo || !turbo.state) {
        return 'Unavailable';
    }
    if (turbo.state === 'FREE') {
        return 'Free';
    } else if (turbo.state === 'TIMER') {
        return 'Timer';
    } else if (turbo.state === 'IN_PROGRESS') {
        return 'In Progress';
    } else if (turbo.state === 'WON') {
        return 'Won';
    } else if (turbo.state === 'USED') {
        return 'Used';
    } else {
        return 'Locked';
    }
};