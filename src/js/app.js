// Get translation manager from global scope
const translationManager = window.translationManager;

// No more toasts - they're annoying

// Function to update all translations on the page
const updateTranslations = () => {
    // Update elements with data-translate attribute
    document.querySelectorAll('[data-translate]').forEach(element => {
        const key = element.getAttribute('data-translate');
        element.textContent = translationManager.t(key);
    });
    
    // Update elements with data-translate-placeholder attribute
    document.querySelectorAll('[data-translate-placeholder]').forEach(element => {
        const key = element.getAttribute('data-translate-placeholder');
        element.placeholder = translationManager.t(key);
    });
    
    // Update elements with data-translate-title attribute
    document.querySelectorAll('[data-translate-title]').forEach(element => {
        const key = element.getAttribute('data-translate-title');
        element.title = translationManager.t(key);
    });
    
    // Update page title
    document.title = translationManager.t('common.title');
};

// Function to update settings display
const updateSettingsDisplay = (settings) => {
    // Header status badges
    const mockStatus = document.getElementById('mock-status');
    if (mockStatus) {
        if (settings.mock) {
            mockStatus.textContent = translationManager.t('common.on');
            mockStatus.className = 'badge badge-sm badge-success';
        } else {
            mockStatus.textContent = translationManager.t('common.off');
            mockStatus.className = 'badge badge-sm badge-neutral';
        }
    }
    
    const stayLoggedInStatus = document.getElementById('stay-logged-in-status');
    if (stayLoggedInStatus) {
        if (settings.stayLoggedIn) {
            stayLoggedInStatus.textContent = translationManager.t('common.on');
            stayLoggedInStatus.className = 'badge badge-sm badge-success';
        } else {
            stayLoggedInStatus.textContent = translationManager.t('common.off');
            stayLoggedInStatus.className = 'badge badge-sm badge-neutral';
        }
    }
};

// Function to format time remaining
const formatTimeRemaining = (endTime) => {
    const now = Math.floor(Date.now() / 1000);
    const remaining = endTime - now;
    
    if (remaining <= 0) {
        return 'Ended';
    }
    
    const days = Math.floor(remaining / 86400);
    const hours = Math.floor((remaining % 86400) / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    
    if (days > 0) {
        return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
        return `${hours}h ${minutes}m`;
    } else {
        return `${minutes}m`;
    }
};

// Function to format end time
const formatEndTime = (endTime, timezone = 'local') => {
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
const getBoostStatus = (boost) => {
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



// Function to render challenges
const renderChallenges = async (challenges, timezone = 'local', autovoteRunning = false) => {
    await window.api.logDebug('🎨 === Rendering Challenges ===', {
        challengesCount: challenges.length,
        firstChallenge: challenges[0],
    });
    
    const container = document.getElementById('challenges-container');
    
    if (!challenges || challenges.length === 0) {
        container.innerHTML = `<div class="text-center py-4 text-base-content/60">${translationManager.t('app.pleaseLogin')}</div>`;
        return;
    }
    
    // Sort challenges by ending time (shortest time remaining first)
    const sortedChallenges = challenges.sort((a, b) => {
        const timeA = a.close_time - Math.floor(Date.now() / 1000);
        const timeB = b.close_time - Math.floor(Date.now() / 1000);
        return timeA - timeB;
    });
    
    const challengesHtml = sortedChallenges.map(challenge => {
        // Log challenge processing (synchronously to avoid async issues)
        console.log('🎨 Processing challenge:', challenge.title);
        
        const timeRemaining = formatTimeRemaining(challenge.close_time, timezone);
        const endTime = formatEndTime(challenge.close_time, timezone);
        const boostStatus = getBoostStatus(challenge.member.boost, challenge.id, challenge.close_time);
        const exposureFactor = challenge.member.ranking.exposure.exposure_factor;
        const entries = challenge.member.ranking.entries;
        
        // Get user progress data
        const userProgress = challenge.member.ranking.total;
        const challengeStats = {
            entries: challenge.entries,
            players: challenge.players,
            votes: challenge.votes,
            maxPhotos: challenge.max_photo_submits,
            prizeWorth: challenge.prizes_worth,
        };
        
        // Get next ranking level info
        const getNextLevelInfo = () => {
            if (challenge.ranking_levels && userProgress && userProgress.level !== undefined) {
                const currentLevel = userProgress.level;
                const nextLevel = currentLevel + 1;
                const nextLevelKey = `level_${nextLevel}`;
                
                if (challenge.ranking_levels[nextLevelKey]) {
                    const votesNeeded = challenge.ranking_levels[nextLevelKey] - userProgress.votes;
                    
                    // Get next level name based on level number
                    const getLevelName = (level) => {
                        switch(level) {
                        case 1: return 'SKILLED';
                        case 2: return 'PREMIER';
                        case 3: return 'ELITE';
                        case 4: return 'ALLSTAR';
                        case 5: return 'MASTER';
                        default: return `LEVEL ${level}`;
                        }
                    };
                    
                    return { 
                        nextLevel, 
                        votesNeeded, 
                        levelName: getLevelName(nextLevel),
                    };
                }
            }
            return null;
        };
        
        const nextLevelInfo = getNextLevelInfo();
        
        console.log('🎨 Processed values:', {
            timeRemaining,
            endTime,
            boostStatus,
            exposureFactor,
            entriesCount: entries.length,
        });
        
        // Create entries display with detailed information
        let entriesHtml = entries.map(entry => {
            const boostIcon = entry.boost === 1 ? '🚀' : '';
            const guruIcon = entry.guru_pick ? '⭐' : '';
            const turboIcon = entry.turbo ? '⚡' : '📷';
            const boostClass = entry.boost === 1 ? 'badge-success' : 'badge-secondary';
            
            return `
                <div class="badge badge-outline ${boostClass} ${entry.turbo ? 'badge-warning' : ''}">
                    ${turboIcon} ${boostIcon} ${guruIcon} ${translationManager.t('app.rank')} ${entry.rank} (${entry.votes} ${translationManager.t('app.votes')})
                </div>
            `;
        }).join('');
        
        if (entries.length === 0) {
            entriesHtml = `<span class="text-base-content/60">${translationManager.t('app.noEntries')}</span>`;
        }
        
        // Show vote button only if autovote is not running and challenge is active
        const showVoteButton = !autovoteRunning && 
                              challenge.start_time < Math.floor(Date.now() / 1000) && 
                              exposureFactor < 100;
        
        const voteButtonHtml = showVoteButton ? `
                            <button class="challenge-vote-btn btn btn-latvian btn-sm" data-challenge-id="${challenge.id}" data-challenge-title="${challenge.title}">
                <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
                ${translationManager.t('app.vote')}
            </button>
        ` : '';
        
        return `
            <div class="border rounded-lg p-3 mb-3 bg-base-100">
                <div class="space-y-2">
                    <!-- Title and Description -->
                    <div class="flex justify-between items-start">
                        <div class="flex-1">
                            <h3 class="font-bold text-base">${challenge.title}</h3>
                            <p class="text-xs text-base-content/60">${challenge.welcome_message}</p>
                            <!-- Challenge Type Badges -->
                            <div class="flex gap-1 mt-1">
                                ${challenge.type === 'speed' ? `<span class="badge badge-xs badge-error">${translationManager.t('app.fast')}</span>` : 
        challenge.type === 'default' ? `<span class="badge badge-xs badge-success">${translationManager.t('app.normal')}</span>` : 
            challenge.badge ? `<span class="badge badge-xs badge-info">${challenge.badge}</span>` : ''}
                                ${challenge.max_photo_submits > 1 ? `<span class="badge badge-xs badge-warning">${challenge.max_photo_submits} ${translationManager.t('app.photos')}</span>` : ''}
                            </div>
                            <!-- Challenge URL -->
                            ${challenge.url ? `
                                <div class="text-xs text-base-content/40 mt-1">
                                    <button onclick="openChallengeUrl('${challenge.url}')" class="font-mono hover:text-latvian hover:underline text-left">
                                        gurushots.com/challenge/${challenge.url}
                                    </button>
                                </div>
                            ` : ''}
                        </div>
                        ${voteButtonHtml}
                    </div>
                    
                    <!-- Challenge Statistics -->
                    <div class="grid grid-cols-4 gap-2 text-xs">
                        <div class="text-center p-2 bg-base-200 rounded">
                            <div class="font-medium">${translationManager.t('app.entries')}</div>
                            <div>${challengeStats.entries.toLocaleString()}</div>
                        </div>
                        <div class="text-center p-2 bg-base-200 rounded">
                            <div class="font-medium">${translationManager.t('app.players')}</div>
                            <div>${challengeStats.players.toLocaleString()}</div>
                        </div>
                        <div class="text-center p-2 bg-base-200 rounded">
                            <div class="font-medium">${translationManager.t('app.votes')}</div>
                            <div>${challengeStats.votes.toLocaleString()}</div>
                        </div>
                        <div class="text-center p-2 bg-base-200 rounded">
                            <div class="font-medium">${translationManager.t('app.prize')}</div>
                            <div>${challengeStats.prizeWorth}</div>
                        </div>
                    </div>
                    
                    <!-- User Progress -->
                    ${userProgress && userProgress.votes > 0 ? `
                        <div class="bg-base-200 rounded p-2">
                            <div class="flex justify-between items-center mb-1">
                                <span class="text-xs font-medium">${translationManager.t('app.yourProgress')}</span>
                                <span class="badge badge-xs ${userProgress.level_name === 'ELITE' ? 'badge-warning' : 'badge-info'}">
                                    ${userProgress.level_name} ${userProgress.level}
                                </span>
                            </div>
                            <div class="flex justify-between text-xs mb-1">
                                <span>${translationManager.t('app.rank')} ${userProgress.rank} ${translationManager.t('app.of')} ${challengeStats.players}</span>
                                <span>${userProgress.votes} ${translationManager.t('app.votes')}</span>
                            </div>
                            <div class="w-full bg-base-300 rounded-full h-1.5">
                                <div class="bg-latvian h-1.5 rounded-full" style="width: ${userProgress.percent}%"></div>
                            </div>
                            <div class="text-xs text-base-content/60 mt-1">${userProgress.next_message}</div>
                            ${nextLevelInfo ? `
                                <div class="text-xs text-base-content/60 mt-1">
                                    ${translationManager.t('app.next')}: ${nextLevelInfo.levelName} (${nextLevelInfo.votesNeeded} ${translationManager.t('app.votesNeeded')})
                                </div>
                            ` : ''}
                        </div>
                    ` : ''}
                    
                    <!-- Challenge Stats -->
                    <div class="grid grid-cols-5 gap-2 text-xs">
                        <div class="text-center p-2 bg-base-200 rounded">
                            <div class="font-medium">${translationManager.t('app.time')}</div>
                            <div class="${timeRemaining === 'Ended' ? 'text-error' : 'text-success'}">${timeRemaining}</div>
                        </div>
                        <div class="text-center p-2 bg-base-200 rounded">
                            <div class="font-medium">${translationManager.t('app.ends')}</div>
                            <div class="text-xs">${endTime}</div>
                        </div>
                        <div class="text-center p-2 bg-base-200 rounded">
                            <div class="font-medium">${translationManager.t('app.exposure')}</div>
                            <div>${exposureFactor}%</div>
                        </div>
                        <div class="text-center p-2 bg-base-200 rounded">
                            <div class="font-medium">${translationManager.t('app.boost')}</div>
                            <div class="${boostStatus.includes('Available') ? 'text-success' : boostStatus === 'Used' ? 'text-warning' : 'text-error'}">${boostStatus.includes('Available') ? translationManager.t('app.available') : boostStatus === 'Used' ? 'Used' : 'None'}</div>
                            <button class="btn btn-xs btn-ghost mt-1 tooltip" data-tip="Loading..." id="boost-config-${challenge.id}" onclick="configureBoost(${challenge.id}, '${challenge.title}')">
                                ⚙️
                            </button>
                        </div>
                        <div class="text-center p-2 bg-base-200 rounded">
                            <div class="font-medium">${translationManager.t('app.yourEntries')}</div>
                            <div>${entries.length}/${challenge.max_photo_submits}</div>
                        </div>
                    </div>
                    
                    <!-- Challenge Tags -->
                    ${challenge.tags && challenge.tags.length > 0 ? `
                        <div class="flex flex-wrap gap-1">
                            ${challenge.tags.map(tag => `<span class="badge badge-ghost badge-xs">${tag}</span>`).join('')}
                        </div>
                    ` : ''}
                    
                    <!-- Entries -->
                    ${entries.length > 0 ? `
                        <div>
                            <div class="text-xs text-base-content/60 mb-1">${translationManager.t('app.entryDetails')}:</div>
                            <div class="flex flex-wrap gap-1">
                                ${entriesHtml}
                            </div>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
    
    container.innerHTML = challengesHtml;
    
    // Update boost threshold displays
    await updateBoostThresholdDisplays(sortedChallenges);
    
    // Add event listeners to vote buttons
    if (!autovoteRunning) {
        document.querySelectorAll('.challenge-vote-btn').forEach(button => {
            button.addEventListener('click', async (e) => {
                const challengeId = e.target.closest('.challenge-vote-btn').dataset.challengeId;
                const challengeTitle = e.target.closest('.challenge-vote-btn').dataset.challengeTitle;
                
                // Disable button and show loading
                const btn = e.target.closest('.challenge-vote-btn');
                const originalText = btn.innerHTML;
                btn.disabled = true;
                btn.innerHTML = `
                    <span class="loading loading-spinner loading-xs"></span>
                    ${translationManager.t('app.voting')}
                `;
                
                // Hide refresh button while single vote is running
                singleVoteRunning = true;
                const refreshBtn = document.getElementById('refresh-challenges');
                if (refreshBtn) {
                    refreshBtn.style.display = 'none';
                }
                
                try {
                    // Call the voting function for this specific challenge
                    const result = await window.api.voteOnChallenge(challengeId, challengeTitle);
                    
                    if (result && result.success) {
                        // Show success feedback
                        btn.innerHTML = `
                            <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                            </svg>
                            ${translationManager.t('app.voted')}
                        `;
                        btn.className = 'challenge-vote-btn btn btn-success btn-sm';
                        
                        // Refresh challenges immediately after successful vote
                        const currentTimezone = document.getElementById('timezone-select')?.value || 'local';
                        await loadChallenges(currentTimezone, autovoteRunning);
                        
                        // Re-enable immediately and show refresh button
                        btn.disabled = false;
                        btn.innerHTML = originalText;
                        btn.className = 'challenge-vote-btn btn btn-latvian btn-sm';
                        
                        // Show refresh button again immediately
                        singleVoteRunning = false;
                        if (refreshBtn && !autovoteRunning) {
                            refreshBtn.style.display = 'inline-flex';
                        }
                    } else {
                        // Show error feedback for API error
                        console.error('Voting failed:', result?.error || 'Unknown error');
                        btn.innerHTML = `
                            <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                            </svg>
                            ${translationManager.t('app.error')}
                        `;
                        btn.className = 'challenge-vote-btn btn btn-error btn-sm';
                        
                        // Re-enable immediately and show refresh button
                        btn.disabled = false;
                        btn.innerHTML = originalText;
                        btn.className = 'challenge-vote-btn btn btn-latvian btn-sm';
                        
                        // Show refresh button again immediately
                        singleVoteRunning = false;
                        if (refreshBtn && !autovoteRunning) {
                            refreshBtn.style.display = 'inline-flex';
                        }
                    }
                    
                } catch (error) {
                    console.error('Error voting on challenge:', error);
                    
                    // Show error feedback
                    btn.innerHTML = `
                        <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                        ${translationManager.t('app.error')}
                    `;
                    btn.className = 'challenge-vote-btn btn btn-error btn-sm';
                    
                    // Re-enable immediately and show refresh button
                    btn.disabled = false;
                    btn.innerHTML = originalText;
                    btn.className = 'challenge-vote-btn btn btn-latvian btn-sm';
                    
                    // Show refresh button again immediately
                    singleVoteRunning = false;
                    if (refreshBtn && !autovoteRunning) {
                        refreshBtn.style.display = 'inline-flex';
                    }
                }
            });
        });
    }
};

// Function to load challenges
const loadChallenges = async (timezone = 'local', autovoteRunning = false) => {
    try {
        await window.api.logDebug('🔄 === Loading Challenges ===');
        
        // Get token from settings
        const settings = await window.api.getSettings();
        await window.api.logDebug('Settings loaded', settings);
        
        if (!settings.token) {
            await window.api.logError('❌ No token found');
            renderChallenges([], timezone, autovoteRunning);
            return;
        }
        
        await window.api.logDebug('🌐 Calling getActiveChallenges', {
            token: settings.token.substring(0, 10) + '...',
        });
        
        // Use the real API call that works in both mock and production
        const result = await window.api.getActiveChallenges(settings.token);
        
        await window.api.logDebug('📋 === App Received Result ===', {
            resultType: typeof result,
            resultKeys: Object.keys(result || {}),
            fullResult: result,
        });
        
        if (result && result.challenges) {
            await window.api.logDebug(`✅ Rendering ${result.challenges.length} challenges`, {
                firstChallenge: result.challenges[0],
            });
            renderChallenges(result.challenges, timezone, autovoteRunning);
        } else {
            await window.api.logError('❌ No challenges in result', { result });
            renderChallenges([], timezone, autovoteRunning);
        }
        
    } catch (error) {
        await window.api.logError('❌ Error loading challenges', error);
        renderChallenges([], timezone);
    }
};

// Global function to configure boost for a challenge
window.configureBoost = async (challengeId, challengeTitle) => {
    try {
        // Get current threshold for this challenge
        const currentThreshold = await window.api.getBoostThreshold(challengeId);
        const hours = Math.floor(currentThreshold / 3600);
        const minutes = Math.floor((currentThreshold % 3600) / 60);
        
        // Create modal for boost configuration
        const modalHtml = `
            <div class="modal modal-open">
                <div class="modal-box">
                    <h3 class="font-bold text-lg mb-4">${translationManager.t('app.configureBoost')} "${challengeTitle}"</h3>
                    <div class="form-control">
                        <label class="label">
                            <span class="label-text">${translationManager.t('app.autoBoostWhenTimeRemaining')}</span>
                        </label>
                        <div class="flex gap-2 items-center">
                            <input type="number" id="boost-hours" class="input input-bordered w-20" value="${hours}" min="0" max="24">
                            <span class="text-sm">${translationManager.t('app.hours')}</span>
                            <input type="number" id="boost-minutes" class="input input-bordered w-20" value="${minutes}" min="0" max="59">
                            <span class="text-sm">${translationManager.t('app.minutes')}</span>
                        </div>
                    </div>
                    <div class="modal-action">
                        <button class="btn btn-latvian" onclick="saveBoostConfig(${challengeId})">${translationManager.t('app.save')}</button>
                        <button class="btn" onclick="closeBoostModal()">${translationManager.t('app.cancel')}</button>
                    </div>
                </div>
            </div>
        `;
        
        // Add modal to page
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        
    } catch (error) {
        console.error('Error configuring boost:', error);
    }
};

// Global function to save boost configuration
window.saveBoostConfig = async (challengeId) => {
    try {
        const hours = parseInt(document.getElementById('boost-hours').value) || 0;
        const minutes = parseInt(document.getElementById('boost-minutes').value) || 0;
        const threshold = (hours * 3600) + (minutes * 60);
        
        await window.api.setBoostThreshold(challengeId, threshold);
        closeBoostModal();
        
        // Refresh challenges to show updated configuration
        await loadChallenges(document.getElementById('timezone-select').value, autovoteRunning);
        
    } catch (error) {
        console.error('Error saving boost config:', error);
    }
};

// Global function to close boost modal
window.closeBoostModal = () => {
    const modal = document.querySelector('.modal');
    if (modal) {
        modal.remove();
    }
};

// Global function to open challenge URL in default browser
window.openChallengeUrl = (url) => {
    window.api.openExternalUrl(`https://gurushots.com/challenge/${url}`);
};

// Function to update boost threshold displays
const updateBoostThresholdDisplays = async (challenges) => {
    for (const challenge of challenges) {
        try {
            const threshold = await window.api.getBoostThreshold(challenge.id);
            const hours = Math.floor(threshold / 3600);
            const minutes = Math.floor((threshold % 3600) / 60);
            
            const configButton = document.getElementById(`boost-config-${challenge.id}`);
            if (configButton) {
                configButton.setAttribute('data-tip', `Auto-boost when < ${hours}h ${minutes}m remaining`);
            }
        } catch (error) {
            console.error('Error updating boost threshold display:', error);
        }
    }
};

// Wait for the DOM to be fully loaded
document.addEventListener('DOMContentLoaded', async () => {
    // Show log file location
    const logFile = await window.api.getLogFile();
    console.log('📝 Log file location:', logFile);
    // Get the logout button element
    const logoutBtn = document.getElementById('logoutBtn');
    const themeToggle = document.getElementById('themeToggle');
    const refreshBtn = document.getElementById('refresh-challenges');
    const timezoneSelect = document.getElementById('timezone-select');
    const currentLanguageSpan = document.getElementById('current-language');
    
    // Load initial settings
    let settings = await window.api.getSettings();
    
    // Apply initial theme
    document.documentElement.setAttribute('data-theme', settings.theme);
    themeToggle.checked = settings.theme === 'dark';
    
    // Apply timezone setting
    const currentTimezone = settings.timezone || 'Europe/Riga';
    timezoneSelect.value = currentTimezone;
    
    // Load saved custom timezones from settings
    const savedTimezones = settings.customTimezones || [];
    
    // Add saved custom timezones to the dropdown
    savedTimezones.forEach(tz => {
        if (tz !== 'local') {
            const existingOption = timezoneSelect.querySelector(`option[value="${tz}"]`);
            if (!existingOption) {
                const option = document.createElement('option');
                option.value = tz;
                option.textContent = tz;
                timezoneSelect.appendChild(option);
            }
        }
    });
    
    // If the current timezone is not 'local' and not in saved timezones, add it
    if (currentTimezone !== 'local' && !savedTimezones.includes(currentTimezone)) {
        const existingOption = timezoneSelect.querySelector(`option[value="${currentTimezone}"]`);
        if (!existingOption) {
            const option = document.createElement('option');
            option.value = currentTimezone;
            option.textContent = currentTimezone;
            timezoneSelect.appendChild(option);
        }
    }
    
    // Function to update remove button visibility
    const updateRemoveButton = () => {
        const timezoneRemove = document.getElementById('timezone-remove');
        const currentTimezone = timezoneSelect.value;
        
        // Only show remove button for custom timezones, not 'Europe/Riga'
        if (currentTimezone !== 'Europe/Riga') {
            timezoneRemove.style.visibility = 'visible';
        } else {
            timezoneRemove.style.visibility = 'hidden';
        }
    };

    // Display initial settings
    updateSettingsDisplay(settings);
    
    // Update remove button visibility initially
    updateRemoveButton();
    
    // Wait for translation manager to be initialized
    while (!translationManager.initialized) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    // Set language selector to current language
    const currentLang = translationManager.getCurrentLanguage();
    currentLanguageSpan.textContent = translationManager.t(`common.language${currentLang === 'en' ? 'English' : 'Latvian'}`);
    
    // Apply initial translations
    updateTranslations();
    
    // Load initial challenges
    console.log('About to load challenges...');
    await loadChallenges(timezoneSelect.value);
    console.log('Challenges loaded.');
    
    // Add click event listener to the logout button
    logoutBtn.addEventListener('click', () => {
        // Call the logout method exposed by the preload script
        window.api.logout();
    });
    
    // Handle language change
    document.querySelectorAll('[data-lang]').forEach(item => {
        item.addEventListener('click', async (e) => {
            e.preventDefault();
            const newLanguage = e.target.getAttribute('data-lang');
            await translationManager.setLanguage(newLanguage);
            
            // Update the current language display
            currentLanguageSpan.textContent = translationManager.t(`common.language${newLanguage === 'en' ? 'English' : 'Latvian'}`);
            
            updateTranslations();
            updateSettingsDisplay(settings); // Update status badges with new language
            
            // Close the dropdown by removing the tabindex attribute and re-adding it
            setTimeout(() => {
                const dropdownContent = document.querySelector('.dropdown-content');
                if (dropdownContent) {
                    dropdownContent.removeAttribute('tabindex');
                    dropdownContent.setAttribute('tabindex', '0');
                }
            }, 10);
        });
    });
    
    // Handle theme toggle change
    themeToggle.addEventListener('change', async () => {
        const newTheme = themeToggle.checked ? 'dark' : 'light';
        
        // Update the theme immediately for responsive UI
        document.documentElement.setAttribute('data-theme', newTheme);
        
        // Save the setting
        await window.api.setSetting('theme', newTheme);
        
        // Reload settings to get the updated state
        settings = await window.api.getSettings();
        
        // Update the display
        updateSettingsDisplay(settings);
        
        // No feedback toast - annoying
    });
    
    // Handle timezone toggle
    const timezoneToggle = document.getElementById('timezone-toggle');
    const timezoneInput = document.getElementById('timezone-input');
    
    // Ensure input field is properly initialized
    timezoneInput.value = '';
    
    timezoneToggle.addEventListener('click', () => {
        if (timezoneInput.style.display === 'none' || timezoneInput.style.display === '') {
            timezoneInput.style.display = 'inline-block';
            timezoneToggle.textContent = '✓';
            timezoneInput.value = ''; // Keep input empty
            timezoneInput.focus();
        } else {
            timezoneInput.style.display = 'none';
            timezoneToggle.textContent = '+';
        }
    });
    
    // Handle timezone input
    timezoneInput.addEventListener('keypress', async (e) => {
        if (e.key === 'Enter') {
            const newTimezone = timezoneInput.value.trim();
            
            if (newTimezone === '') {
                // Empty input - revert to local
                timezoneInput.value = '';
                timezoneInput.style.display = 'none';
                timezoneSelect.style.display = 'inline-block';
                timezoneToggle.textContent = '+';
                timezoneSelect.value = 'local';
                await window.api.setSetting('timezone', 'local');
                await loadChallenges('local', autovoteRunning);
                return;
            }
            
            // Validate timezone
            try {
                const testDate = new Date();
                testDate.toLocaleString('en-US', { timeZone: newTimezone });
                
                // Valid timezone - save and use
                await window.api.setSetting('timezone', newTimezone);
                
                // Add the new timezone as an option if it doesn't exist
                const existingOption = timezoneSelect.querySelector(`option[value="${newTimezone}"]`);
                if (!existingOption) {
                    const option = document.createElement('option');
                    option.value = newTimezone;
                    option.textContent = newTimezone;
                    timezoneSelect.appendChild(option);
                }
                
                // Save the custom timezone to settings
                const currentSettings = await window.api.getSettings();
                const customTimezones = currentSettings.customTimezones || [];
                if (!customTimezones.includes(newTimezone)) {
                    customTimezones.push(newTimezone);
                    await window.api.setSetting('customTimezones', customTimezones);
                }
                
                timezoneSelect.value = newTimezone;
                timezoneInput.value = '';
                timezoneInput.style.display = 'none';
                timezoneSelect.style.display = 'inline-block';
                timezoneToggle.textContent = '+';
                
                await loadChallenges(newTimezone, autovoteRunning);
            } catch (error) {
                console.warn('Invalid timezone entered:', error);
                // Invalid timezone - show error and keep input open
                timezoneInput.classList.add('input-error');
                timezoneInput.placeholder = 'Invalid timezone. Try: UTC, America/New_York, Europe/London';
                
                // Clear error after 3 seconds
                setTimeout(() => {
                    timezoneInput.classList.remove('input-error');
                    timezoneInput.placeholder = 'Enter timezone (e.g., UTC, America/New_York)';
                }, 3000);
            }
        }
    });
    
    // Handle timezone select change
    timezoneSelect.addEventListener('change', async () => {
        const newTimezone = timezoneSelect.value;
        
        // Save the setting
        await window.api.setSetting('timezone', newTimezone);
        
        // Update remove button visibility
        updateRemoveButton();
        
        // Reload challenges with new timezone
        await loadChallenges(newTimezone, autovoteRunning);
    });
    
    // Handle timezone remove button
    const timezoneRemove = document.getElementById('timezone-remove');
    timezoneRemove.addEventListener('click', async () => {
        const currentTimezone = timezoneSelect.value;
        
        // Only allow removing custom timezones, not 'Europe/Riga'
        if (currentTimezone !== 'Europe/Riga') {
            // Remove the option from the dropdown
            const option = timezoneSelect.querySelector(`option[value="${currentTimezone}"]`);
            if (option) {
                option.remove();
            }
            
            // Remove from custom timezones in settings
            const currentSettings = await window.api.getSettings();
            const customTimezones = currentSettings.customTimezones || [];
            const updatedTimezones = customTimezones.filter(tz => tz !== currentTimezone);
            await window.api.setSetting('customTimezones', updatedTimezones);
            
            // Set back to Europe/Riga
            timezoneSelect.value = 'Europe/Riga';
            await window.api.setSetting('timezone', 'Europe/Riga');
            
            // Update remove button visibility
            updateRemoveButton();
            
            // Reload challenges
            await loadChallenges('Europe/Riga', autovoteRunning);
        }
    });

    // Handle timezone input blur (when user clicks away)
    timezoneInput.addEventListener('blur', () => {
        // Small delay to allow Enter key to be processed first
        setTimeout(() => {
            if (timezoneInput.style.display !== 'none') {
                timezoneInput.style.display = 'none';
                timezoneSelect.style.display = 'inline-block';
                timezoneToggle.textContent = '+';
                timezoneInput.value = '';
            }
        }, 100);
    });
    
    // Handle refresh button
    refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        refreshBtn.innerHTML = `
            <span class="loading loading-spinner loading-xs"></span>
            ${translationManager.t('common.loading')}...
        `;
        
        await loadChallenges(timezoneSelect.value, autovoteRunning);
        
        refreshBtn.disabled = false;
        refreshBtn.innerHTML = `
            <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
            </svg>
            ${translationManager.t('common.refresh')}
        `;
    });

    // Mock Toggle Functionality
    const mockToggle = document.getElementById('mock-toggle');
    
    // Handle mock toggle
    mockToggle.addEventListener('click', async () => {
        const currentSettings = await window.api.getSettings();
        const newMockValue = !currentSettings.mock;
        
        console.log(`🔄 Mock toggle clicked: ${currentSettings.mock} -> ${newMockValue}`);
        
        // Update the setting
        await window.api.setSetting('mock', newMockValue);
        
        // Update the display
        updateSettingsDisplay({ ...currentSettings, mock: newMockValue });
        
        // Show feedback
        const status = newMockValue ? 'Mock API Enabled' : 'Real API Enabled';
        console.log(`Switched to: ${status}`);
        
        // Force API refresh in main process
        await window.api.refreshApi();
        
        // Refresh challenges to reflect the new API mode
        await loadChallenges(timezoneSelect.value, autovoteRunning);
    });

    // Auto Vote Functionality
    const autovoteToggle = document.getElementById('autovote-toggle');
    const autovoteStatus = document.getElementById('autovote-status');
    const autovoteLastRun = document.getElementById('autovote-last-run');
    const autovoteCycles = document.getElementById('autovote-cycles');

    let autovoteInterval = null;
    let autovoteRunning = false;
    let cycleCount = 0;
    let autoRefreshInterval = null;
    let singleVoteRunning = false;

    // Function to update autovote status
    const updateAutovoteStatus = (status, badgeClass = 'badge-neutral') => {
        // Translate status if it's a known key
        let translatedStatus = status;
        if (status === 'Running') {
            translatedStatus = translationManager.t('common.running');
        } else if (status === 'Stopped') {
            translatedStatus = translationManager.t('common.stopped');
        } else if (status === 'Error') {
            translatedStatus = 'Error'; // Keep error as is
        } else if (status === 'Error: Not logged in') {
            translatedStatus = 'Error: Not logged in'; // Keep error as is
        }
        
        autovoteStatus.textContent = translatedStatus;
        autovoteStatus.className = `badge ${badgeClass}`;
    };

    // Function to update last run time
    const updateLastRun = () => {
        const now = new Date();
        autovoteLastRun.textContent = now.toLocaleTimeString('lv-LV');
    };

    // Function to update cycle count
    const updateCycleCount = () => {
        cycleCount++;
        autovoteCycles.textContent = cycleCount.toString();
    };

    // Function to run a single voting cycle
    const runVotingCycle = async () => {
        console.log(`🔄 runVotingCycle called, autovoteRunning: ${autovoteRunning}`);
        
        // Check if autovote is still running before proceeding
        if (!autovoteRunning) {
            console.log('🛑 Autovote stopped, skipping voting cycle');
            return false;
        }
        
        try {
            console.log(`--- Auto Vote Cycle ${cycleCount + 1} ---`);
            console.log(`Time: ${new Date().toLocaleString()}`);
            
            // Check if user is authenticated
            const settings = await window.api.getSettings();
            if (!settings.token) {
                console.error('No authentication token found. Please login first.');
                updateAutovoteStatus('Error: Not logged in', 'badge-error');
                return false;
            }
            
            // Run the voting process using the API factory
            const result = await window.api.runVotingCycle();
            
            // Check if autovote was stopped during the cycle
            if (!autovoteRunning) {
                console.log('🛑 Autovote stopped during voting cycle, aborting');
                return false;
            }
            
            if (result && result.success) {
                // Double-check that autovote is still running before updating
                if (autovoteRunning) {
                    updateCycleCount();
                    updateLastRun();
                    
                    // Refresh challenges immediately after voting cycle completes
                    await loadChallenges(timezoneSelect.value, autovoteRunning);
                    
                    console.log(`--- Auto Vote Cycle ${cycleCount} Completed ---\n`);
                    return true;
                } else {
                    console.log('🛑 Autovote was stopped, not updating cycle count or refreshing');
                    return false;
                }
            } else {
                console.error('Voting cycle failed:', result?.error || 'Unknown error');
                if (autovoteRunning) {
                    updateAutovoteStatus('Error', 'badge-error');
                }
                return false;
            }
        } catch (error) {
            console.error(`Error during auto vote cycle ${cycleCount + 1}:`, error);
            updateAutovoteStatus('Error', 'badge-error');
            return false;
        }
    };

    // Function to start autovote
    const startAutovote = async () => {
        if (autovoteRunning) return;
        
        autovoteRunning = true;
        shouldCancelVoting = false;
        await window.api.setCancelVoting(false);
        updateAutovoteStatus('Running', 'badge-success');
        
        // Update button
        autovoteToggle.innerHTML = `
            <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
            ${translationManager.t('app.stopAutoVote')}
        `;
        autovoteToggle.className = 'btn btn-error';
        
        // Stop the regular auto-refresh since we'll update after each voting cycle
        stopAutoRefresh();
        
        // Hide the refresh button when autovote is running
        refreshBtn.style.display = 'none';
        
        // Refresh challenges to hide individual vote buttons
        loadChallenges(timezoneSelect.value, autovoteRunning);
        
        // Run immediately
        console.log('▶️ Starting immediate voting cycle');
        runVotingCycle();
        
        // Set up interval for every 3 minutes (180000 ms)
        console.log('⏰ Setting up autovote interval');
        autovoteInterval = setInterval(() => {
            console.log('⏰ Interval triggered, autovoteRunning:', autovoteRunning);
            if (autovoteRunning) {
                runVotingCycle();
            } else {
                console.log('⏰ Autovote stopped, clearing interval');
                clearInterval(autovoteInterval);
                autovoteInterval = null;
            }
        }, 180000);
        
        console.log('=== Auto Vote Started ===');
        console.log('Scheduling voting every 3 minutes');
        console.log('Challenges will update after each voting cycle');
    };

    // Function to stop autovote
    const stopAutovote = async () => {
        console.log('🛑 stopAutovote called, autovoteRunning:', autovoteRunning, 'Interval:', autovoteInterval);
        if (!autovoteRunning) {
            console.log('🛑 Autovote already stopped, returning');
            return;
        }
        
        console.log('🛑 Setting autovoteRunning to false and shouldCancelVoting to true');
        autovoteRunning = false;
        shouldCancelVoting = true;
        await window.api.setCancelVoting(true);
        updateAutovoteStatus('Stopped', 'badge-neutral');
        
        // Update button
        autovoteToggle.innerHTML = `
            <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h1m4 0h1m-6 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
            ${translationManager.t('app.startAutoVote')}
        `;
        autovoteToggle.className = 'btn btn-latvian';
        
        // Clear autovote interval
        console.log('🛑 Clearing autovote interval:', autovoteInterval);
        if (autovoteInterval) {
            clearInterval(autovoteInterval);
            autovoteInterval = null;
            console.log('🛑 Autovote interval cleared');
        }
        
        // Show the refresh button when autovote is stopped (but not if single vote is running)
        if (!singleVoteRunning) {
            refreshBtn.style.display = 'inline-flex';
        }
        
        // Refresh challenges to show individual vote buttons
        loadChallenges(timezoneSelect.value, autovoteRunning);
        
        // Restart the regular auto-refresh
        startAutoRefresh();
        
        console.log('=== Auto Vote Stopped ===');
        console.log('🛑 Final autovoteRunning state:', autovoteRunning);
    };

    // Handle autovote toggle
    autovoteToggle.addEventListener('click', async (e) => {
        e.preventDefault(); // Prevent any default behavior
        console.log('🔄 Autovote toggle clicked, current state:', autovoteRunning, 'Interval:', autovoteInterval);
        if (autovoteRunning) {
            console.log('🛑 Stopping autovote...');
            await stopAutovote();
        } else {
            console.log('▶️ Starting autovote...');
            await startAutovote();
        }
    });

    // Clean up on page unload
    window.addEventListener('beforeunload', () => {
        if (autovoteInterval) {
            clearInterval(autovoteInterval);
        }
        if (autoRefreshInterval) {
            clearInterval(autoRefreshInterval);
        }
    });
    
    // Start auto-refresh for challenges (every 60 seconds when autovote is not running)
    const startAutoRefresh = () => {
        if (!autovoteRunning) {
            autoRefreshInterval = setInterval(() => {
                loadChallenges(timezoneSelect.value, autovoteRunning);
            }, 60000); // 60 seconds
        }
    };
    
    // Stop auto-refresh
    const stopAutoRefresh = () => {
        if (autoRefreshInterval) {
            clearInterval(autoRefreshInterval);
            autoRefreshInterval = null;
        }
    };
    
    // Start auto-refresh initially
    startAutoRefresh();
    
    // No welcome toast - annoying
});