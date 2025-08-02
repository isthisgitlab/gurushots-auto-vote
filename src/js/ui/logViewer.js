/**
 * Log Viewer UI Controller
 * Handles real-time log display in the GUI
 */

import {updateTranslations} from './translations.js';

let logContainer;
let logStatus;

/**
 * Initialize the log viewer when the page loads
 */
document.addEventListener('DOMContentLoaded', async () => {
    logContainer = document.getElementById('log-container');
    logStatus = document.getElementById('log-status');
    
    // Wait for translation manager to be available and initialized
    let attempts = 0;
    while ((!window.translationManager || !window.translationManager.initialized) && attempts < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
    }
    
    // Initialize translations
    if (window.translationManager && window.translationManager.initialized) {
        updateTranslations();
    }
    
    // Connect to log stream
    connectToLogStream();
    
    // Listen for settings changes to update translations
    window.api.onSettingsChanged(() => {
        // Update translations and connection status text
        if (window.translationManager) {
            updateTranslations();
            // Re-apply current connection status with new translations
            const isConnected = logStatus && logStatus.classList.contains('badge-success');
            updateConnectionStatus(isConnected);
        }
    });
});

/**
 * Connect to the log stream from main process
 */
async function connectToLogStream() {
    try {
        // Tell main process we want to start receiving logs
        const result = await window.api.startLogStream();
        
        if (result.success) {
            // Listen for log messages
            window.api.onLogMessage((logData) => {
                addLogEntry(logData);
            });
            
            // Update connection status
            updateConnectionStatus(true);
            
            // Send a test log message to see if streaming works  
            setTimeout(async () => {
                await window.api.logError('🟢 Log viewer connected and ready to receive messages');
            }, 500);
        } else {
            updateConnectionStatus(false);
        }
        
    } catch {
        updateConnectionStatus(false);
    }
}

/**
 * Add a new log entry to the display (newest on top)
 */
function addLogEntry(logData) {
    // Clear the waiting message if it exists
    const waitingMessage = logContainer.querySelector('.text-gray-500');
    if (waitingMessage) {
        waitingMessage.remove();
    }
    
    // Create log entry element
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';
    
    // Format the log message (same as CLI format)
    const { level, message, context, timestamp } = logData;
    
    // Color coding based on log level
    const levelColors = {
        'INFO': 'text-blue-400',
        'SUCCESS': 'text-green-400', 
        'WARNING': 'text-yellow-400',
        'ERROR': 'text-red-400',
        'DEBUG': 'text-gray-400',
        'API': 'text-cyan-400',
        'PROGRESS': 'text-purple-400',
    };
    
    const levelColor = levelColors[level] || 'text-green-400';
    
    logEntry.innerHTML = `
        <span class="text-cyan-400">[${context}]</span>
        <span class="text-gray-400">[${timestamp}]</span>
        <span class="${levelColor}">[${level}]</span>
        <span class="text-white">${escapeHtml(message)}</span>
    `;
    
    // Insert at the top (newest first)
    logContainer.insertBefore(logEntry, logContainer.firstChild);
    
    // Limit the number of displayed entries to prevent memory issues
    const maxEntries = 1000;
    while (logContainer.children.length > maxEntries) {
        logContainer.removeChild(logContainer.lastChild);
    }
}

/**
 * Update the connection status indicator
 */
function updateConnectionStatus(connected) {
    if (connected) {
        logStatus.textContent = window.translationManager.t('logs.connected');
        logStatus.className = 'badge badge-sm badge-success';
    } else {
        logStatus.textContent = window.translationManager.t('logs.disconnected');
        logStatus.className = 'badge badge-sm badge-error';
    }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Handle window close - stop log stream
 */
window.addEventListener('beforeunload', () => {
    if (window.api.stopLogStream) {
        window.api.stopLogStream();
    }
});