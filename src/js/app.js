const translationManager = window.translationManager;

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

    const challengesHtmlArray = await Promise.all(sortedChallenges.map(async challenge => {
        // Log challenge processing (synchronously to avoid async issues)
        console.log('🎨 Processing challenge:', challenge.title);

        const timeRemaining = formatTimeRemaining(challenge.close_time, timezone);
        const endTime = formatEndTime(challenge.close_time, timezone);
        const boostStatus = getBoostStatus(challenge.member.boost);
        const exposureFactor = challenge.member.ranking.exposure.exposure_factor;
        const entries = challenge.member.ranking.entries;

        // Check if this challenge has any custom settings overrides
        let hasCustomSettings = false;
        try {
            const schema = await window.api.getSettingsSchema();
            for (const key of Object.keys(schema)) {
                const override = await window.api.getChallengeOverride(key, challenge.id.toString());
                if (override !== null) {
                    hasCustomSettings = true;
                    break;
                }
            }
        } catch (error) {
            console.warn('Error checking for custom settings:', error);
        }

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
                        switch (level) {
                        case 1:
                            return 'SKILLED';
                        case 2:
                            return 'PREMIER';
                        case 3:
                            return 'ELITE';
                        case 4:
                            return 'ALLSTAR';
                        case 5:
                            return 'MASTER';
                        default:
                            return `LEVEL ${level}`;
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
            // Show boost icon if entry is boosted OR if boost is used for this challenge
            const isEntryBoosted = entry.boost === 1;
            const isBoostUsed = boostStatus === 'Used';
            const boostIcon = (isEntryBoosted || isBoostUsed) ? '🚀' : '';
            const guruIcon = entry.guru_pick ? '⭐' : '';
            // Show camera only for regular entries (no turbo, no boost, no guru pick)
            const isRegularEntry = !entry.turbo && !isEntryBoosted && !isBoostUsed && !entry.guru_pick;
            const turboIcon = entry.turbo ? '⚡' : (isRegularEntry ? '📷' : '');
            const boostClass = (isEntryBoosted || isBoostUsed) ? 'badge-success' : 'badge-secondary';

            // Show boost button only if boost is available and entry is not already boosted
            const showBoostButton = boostStatus.includes('Available') && entry.boost !== 1;
            const boostButtonHtml = showBoostButton ? `
                <button class="btn btn-xs btn-warning ml-1 entry-boost-btn" 
                        data-challenge-id="${challenge.id}" 
                        data-image-id="${entry.id}" 
                        data-entry-rank="${entry.rank}"
                        onclick="boostEntry(${challenge.id}, '${entry.id}', ${entry.rank})">
                    🚀
                </button>
            ` : '';

            return `
                <div class="badge badge-outline ${boostClass} ${entry.turbo ? 'badge-warning' : ''} flex items-center">
                    ${turboIcon} ${boostIcon} ${guruIcon} ${translationManager.t('app.rank')} ${entry.rank} (${entry.votes} ${translationManager.t('app.votes')})
                    ${boostButtonHtml}
                </div>
            `;
        }).join('');

        if (entries.length === 0) {
            entriesHtml = `<span class="text-base-content/60">${translationManager.t('app.noEntries')}</span>`;
        }

        // Check if boost-only mode is enabled for this challenge
        const onlyBoost = await window.api.getEffectiveSetting('onlyBoost', challenge.id.toString());

        // Show vote button if:
        // 1. Autovote is not running, OR
        // 2. Autovote is running but boost-only mode is enabled for this challenge
        // AND challenge is active and exposure factor is less than 100 (not configured threshold)
        const showVoteButton = (!autovoteRunning || (autovoteRunning && onlyBoost)) &&
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

        // Settings button (always visible)
        const settingsButtonHtml = `
            <button class="challenge-settings-btn btn btn-ghost btn-sm" data-challenge-id="${challenge.id}" data-challenge-title="${challenge.title}" title="Challenge Settings">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                </svg>
            </button>
        `;

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
                                ${hasCustomSettings ? '<span class="badge badge-xs badge-accent" title="Custom settings configured">⚙️</span>' : ''}
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
                        <div class="flex gap-2">
                            ${voteButtonHtml}
                            ${settingsButtonHtml}
                        </div>
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
    }));

    const challengesHtml = challengesHtmlArray.join('');

    container.innerHTML = challengesHtml;

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

    // Add event listeners to challenge settings buttons (always add, regardless of autovote status)
    document.querySelectorAll('.challenge-settings-btn').forEach(button => {
        button.addEventListener('click', async (e) => {
            const challengeId = e.target.closest('.challenge-settings-btn').dataset.challengeId;
            const challengeTitle = e.target.closest('.challenge-settings-btn').dataset.challengeTitle;
            openChallengeSettingsModal(challengeId, challengeTitle);
        });
    });
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

            // Extract challenge IDs for cleanup
            const activeChallengeIds = result.challenges.map(challenge => challenge.id.toString());


            try {
                await window.api.cleanupStaleChallengeSetting(activeChallengeIds);
            } catch (error) {
                console.warn('Failed to cleanup stale challenge settings:', error);
            }

            renderChallenges(result.challenges, timezone, autovoteRunning);
        } else {
            await window.api.logError('❌ No challenges in result', {result});
            renderChallenges([], timezone, autovoteRunning);
        }

    } catch (error) {
        await window.api.logError('❌ Error loading challenges', error);
        renderChallenges([], timezone);
    }
};

// Global function to open settings modal
window.openSettingsModal = async () => {
    try {
        // Get the settings schema and current values
        const schema = await window.api.getSettingsSchema();

        if (!schema || Object.keys(schema).length === 0) {
            console.error('No schema available');
            alert('Settings schema not available. Please try again.');
            return;
        }

        const globalDefaults = {};

        // Load current global defaults
        for (const key of Object.keys(schema)) {
            try {
                globalDefaults[key] = await window.api.getGlobalDefault(key);
            } catch (error) {
                console.warn(`Error loading global default for ${key}:`, error);
                globalDefaults[key] = schema[key].default;
            }
        }

        // Get current challenges for per-challenge overrides
        const settings = await window.api.getSettings();
        const result = await window.api.getActiveChallenges(settings.token);
        const challenges = result?.challenges || [];

        // Create modal HTML
        const modalHtml = await generateSettingsModalHtml(schema, globalDefaults, challenges);

        // Add modal to page
        document.body.insertAdjacentHTML('beforeend', modalHtml);

        // Initialize modal event handlers
        initializeSettingsModal(schema, challenges);

    } catch (error) {
        console.error('Error opening settings modal:', error);
        alert('Failed to open settings modal. Check console for details.');
    }
};

// Function to generate settings modal HTML based on schema (simplified to match per-challenge design)
const generateSettingsModalHtml = async (schema, globalDefaults, challenges) => {
    console.log('generateSettingsModalHtml called with:', {schema, globalDefaults, challengesCount: challenges.length});

    // Validate inputs
    if (!schema || Object.keys(schema).length === 0) {
        console.error('No schema provided to generateSettingsModalHtml');
        return '<div class="text-error">Error: No settings schema available</div>';
    }

    if (!globalDefaults) {
        console.error('No globalDefaults provided to generateSettingsModalHtml');
        return '<div class="text-error">Error: No global defaults available</div>';
    }

    // Generate global settings inputs (same style as per-challenge)
    let globalSettingsHtml = '';
    for (const [key, config] of Object.entries(schema)) {
        try {
            const value = globalDefaults[key];
            console.log(`Processing global setting ${key}:`, {value, config});

            if (value === undefined || value === null) {
                console.warn(`Missing value for global setting ${key}, using default`);
                globalDefaults[key] = config.default;
            }

            const inputHtml = generateInputHtml(key, config, globalDefaults[key], '');
            const labelText = translationManager.t(config.label) || config.label || key;
            const descText = translationManager.t(config.description) || config.description || 'No description';

            globalSettingsHtml += `
                <div class="form-control mb-4">
                    <label class="label">
                        <span class="label-text font-medium" data-translate="${config.label}">${labelText}</span>
                        <span class="badge badge-ghost badge-xs ml-2" data-translate="app.globalDefault">${translationManager.t('app.globalDefault')}</span>
                    </label>
                    <p class="text-xs text-base-content/60 mb-2" data-translate="${config.description}">${descText}</p>
                    <div class="flex items-center gap-2">
                        ${inputHtml}
                    </div>
                </div>
            `;
        } catch (error) {
            console.error(`Error generating HTML for global setting ${key}:`, error);
            // Add a simple fallback
            globalSettingsHtml += `
                <div class="form-control mb-4">
                    <label class="label">
                        <span class="label-text font-medium">${key}</span>
                        <span class="badge badge-error badge-xs ml-2">Error</span>
                    </label>
                    <p class="text-xs text-base-content/60 mb-2">Error loading setting</p>
                    <div class="text-error">Error: ${error.message || 'Unknown error'}</div>
                </div>
            `;
        }
    }

    console.log('Generated global settings HTML length:', globalSettingsHtml.length);

    // Generate UI settings HTML
    const uiSettingsHtml = await generateUISettingsHtml();

    const modalHtml = `
        <div class="modal modal-open">
            <div class="modal-box max-w-3xl">
                <h3 class="font-bold text-lg mb-4">
                    <svg class="w-5 h-5 inline mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                    </svg>
                    <span data-translate="app.globalSettings">${translationManager.t('app.globalSettings')}</span>
                </h3>
                
                <div class="space-y-6">
                    <!-- App Settings Section -->
                    <div>
                        <h4 class="font-semibold text-base mb-3 border-b border-base-300 pb-2" data-translate="app.applicationSettings">${translationManager.t('app.applicationSettings')}</h4>
                        <div class="space-y-4">
                            ${uiSettingsHtml || `<div class="text-error" data-translate="app.noUiSettingsToDisplay">${translationManager.t('app.noUiSettingsToDisplay')}</div>`}
                        </div>
                    </div>
                    
                    <!-- Challenge Settings Section -->
                    <div>
                        <h4 class="font-semibold text-base mb-3 border-b border-base-300 pb-2" data-translate="app.challengeDefaults">${translationManager.t('app.challengeDefaults')}</h4>
                        <div class="space-y-4">
                            ${globalSettingsHtml || `<div class="text-error" data-translate="app.noGlobalSettingsToDisplay">${translationManager.t('app.noGlobalSettingsToDisplay')}</div>`}
                        </div>
                    </div>
                </div>
                
                <div class="modal-action">
                    <button class="btn btn-latvian" onclick="saveGlobalSettings()">
                        <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                        </svg>
                        <span data-translate="app.save">${translationManager.t('app.save') || 'Save'}</span>
                    </button>
                    <button class="btn" onclick="closeSettingsModal()">
                        <span data-translate="app.cancel">${translationManager.t('app.cancel') || 'Cancel'}</span>
                    </button>
                </div>
            </div>
        </div>
    `;

    console.log('Final modal HTML length:', modalHtml.length);
    return modalHtml;
};

// Function to generate UI settings HTML
const generateUISettingsHtml = async () => {
    try {
        const settings = await window.api.getSettings();

        let uiSettingsHtml = '';

        // Theme Setting
        uiSettingsHtml += `
            <div class="form-control mb-4">
                <label class="label">
                    <span class="label-text font-medium" data-translate="app.theme">${translationManager.t('app.theme')}</span>
                    <span class="badge badge-ghost badge-xs ml-2" data-translate="app.uiSetting">${translationManager.t('app.uiSetting')}</span>
                </label>
                <p class="text-xs text-base-content/60 mb-2" data-translate="app.themeDesc">${translationManager.t('app.themeDesc')}</p>
                <div class="flex items-center gap-2">
                    <span class="text-sm" data-translate="common.light">${translationManager.t('common.light')}</span>
                    <input type="checkbox" id="modal-theme-toggle" class="toggle toggle-sm" ${settings.theme === 'dark' ? 'checked' : ''}>
                    <span class="text-sm" data-translate="common.dark">${translationManager.t('common.dark')}</span>
                </div>
            </div>
        `;

        // Language Setting
        const currentLang = settings.language || 'en';
        uiSettingsHtml += `
            <div class="form-control mb-4">
                <label class="label">
                    <span class="label-text font-medium" data-translate="app.language">${translationManager.t('app.language')}</span>
                    <span class="badge badge-ghost badge-xs ml-2" data-translate="app.uiSetting">${translationManager.t('app.uiSetting')}</span>
                </label>
                <p class="text-xs text-base-content/60 mb-2" data-translate="app.languageDesc">${translationManager.t('app.languageDesc')}</p>
                <div class="flex items-center gap-2">
                    <select id="modal-language-select" class="select select-bordered select-sm">
                        <option value="en" ${currentLang === 'en' ? 'selected' : ''}>English</option>
                        <option value="lv" ${currentLang === 'lv' ? 'selected' : ''}>Latviešu</option>
                    </select>
                </div>
            </div>
        `;

        // Timezone Setting
        const currentTimezone = settings.timezone || 'Europe/Riga';
        const customTimezones = settings.customTimezones || [];
        let timezoneOptions = '<option value="Europe/Riga">Europe/Riga</option>';

        // Add custom timezones
        customTimezones.forEach(tz => {
            if (tz !== 'Europe/Riga') {
                timezoneOptions += `<option value="${tz}"${currentTimezone === tz ? ' selected' : ''}>${tz}</option>`;
            }
        });

        // If current timezone is not in the list, add it
        if (currentTimezone !== 'Europe/Riga' && !customTimezones.includes(currentTimezone)) {
            timezoneOptions += `<option value="${currentTimezone}" selected>${currentTimezone}</option>`;
        }

        uiSettingsHtml += `
            <div class="form-control mb-4">
                <label class="label">
                    <span class="label-text font-medium" data-translate="app.timezone">${translationManager.t('app.timezone')}</span>
                    <span class="badge badge-ghost badge-xs ml-2" data-translate="app.uiSetting">${translationManager.t('app.uiSetting')}</span>
                </label>
                <p class="text-xs text-base-content/60 mb-2" data-translate="app.timezoneDesc">${translationManager.t('app.timezoneDesc')}</p>
                <div class="flex items-center gap-2">
                    <select id="modal-timezone-select" class="select select-bordered select-sm" style="width: 200px;">
                        ${timezoneOptions}
                    </select>
                    <button id="modal-timezone-add" class="btn btn-ghost btn-sm" title="${translationManager.t('app.addCustomTimezone')}">+</button>
                    <button id="modal-timezone-remove" class="btn btn-ghost btn-sm text-red-500" title="${translationManager.t('app.removeCurrentTimezone')}" style="visibility: ${currentTimezone !== 'Europe/Riga' ? 'visible' : 'hidden'}">×</button>
                </div>
                <input id="modal-timezone-input" type="text" placeholder="${translationManager.t('app.timezonePlaceholder')}" class="input input-bordered input-sm mt-2" style="display: none; width: 250px;">
            </div>
        `;

        // Stay Logged In Setting
        uiSettingsHtml += `
            <div class="form-control mb-4">
                <label class="label">
                    <span class="label-text font-medium" data-translate="app.stayLoggedIn">${translationManager.t('app.stayLoggedIn')}</span>
                    <span class="badge badge-ghost badge-xs ml-2" data-translate="app.uiSetting">${translationManager.t('app.uiSetting')}</span>
                </label>
                <p class="text-xs text-base-content/60 mb-2" data-translate="app.stayLoggedInDesc">${translationManager.t('app.stayLoggedInDesc')}</p>
                <div class="flex items-center gap-2">
                    <input type="checkbox" id="modal-stay-logged-in" class="checkbox checkbox-sm" ${settings.stayLoggedIn ? 'checked' : ''}>
                    <span class="text-sm" data-translate="app.rememberLoginSession">${translationManager.t('app.rememberLoginSession')}</span>
                </div>
            </div>
        `;

        return uiSettingsHtml;
    } catch (error) {
        console.error('Error generating UI settings HTML:', error);
        return `<div class="text-error" data-translate="app.errorLoadingUiSettings">${translationManager.t('app.errorLoadingUiSettings')}</div>`;
    }
};

// Function to generate input HTML based on setting type
const generateInputHtml = (key, config, value, challengeId = '', hasOverride = false) => {
    try {
        console.log(`Generating input HTML for ${key}:`, {config, value, challengeId, hasOverride});

        if (!config) {
            console.error(`No config provided for setting ${key}`);
            return `<div class="text-error" data-translate="app.missingConfigFor">${translationManager.t('app.missingConfigFor')} ${key}</div>`;
        }

        const inputId = challengeId ? `${key}-${challengeId}` : `global-${key}`;
        const inputClass = hasOverride ? 'input-warning' : '';

        // Handle undefined/null values
        if (value === undefined || value === null) {
            console.warn(`Using default value for ${key}:`, config.default);
            value = config.default || 0;
        }

        // Safe translation with fallbacks
        const hoursText = translationManager.t('app.hours') || 'hours';
        const minutesText = translationManager.t('app.minutes') || 'minutes';
        const resetTooltip = translationManager.t('app.resetToGlobal') || 'Reset to Global';

        switch (config.type) {
        case 'time': {
            const hours = Math.floor(Number(value) / 3600);
            const minutes = Math.floor((Number(value) % 3600) / 60);
            return `
                    <div class="flex gap-2 items-center">
                        <input type="number" id="${inputId}-hours" class="input input-bordered input-sm w-20 ${inputClass}" 
                               value="${hours}" min="0" max="24" data-setting="${key}" data-challenge="${challengeId}">
                        <span class="text-sm" data-translate="app.hours">${hoursText}</span>
                        <input type="number" id="${inputId}-minutes" class="input input-bordered input-sm w-20 ${inputClass}" 
                               value="${minutes}" min="0" max="59" data-setting="${key}" data-challenge="${challengeId}">
                        <span class="text-sm" data-translate="app.minutes">${minutesText}</span>
                        ${challengeId ? `<button class="btn btn-xs btn-ghost" onclick="resetChallengeOverride('${key}', '${challengeId}')" title="${resetTooltip}">↻</button>` : ''}
                    </div>
                `;
        }

        case 'boolean': {
            return `
                    <div class="flex items-center gap-2">
                        <input type="checkbox" id="${inputId}" class="checkbox checkbox-sm ${inputClass}" 
                               ${value ? 'checked' : ''} data-setting="${key}" data-challenge="${challengeId}">
                        ${challengeId ? `<button class="btn btn-xs btn-ghost" onclick="resetChallengeOverride('${key}', '${challengeId}')" title="${resetTooltip}">↻</button>` : ''}
                    </div>
                `;
        }

        case 'number':
        default:
            return `
                    <div class="flex items-center gap-2">
                        <input type="number" id="${inputId}" class="input input-bordered input-sm w-24 ${inputClass}" 
                               value="${Number(value)}" min="0" data-setting="${key}" data-challenge="${challengeId}">
                        ${challengeId ? `<button class="btn btn-xs btn-ghost" onclick="resetChallengeOverride('${key}', '${challengeId}')" title="${resetTooltip}">↻</button>` : ''}
                    </div>
                `;
        }
    } catch (error) {
        console.error(`Error generating input HTML for ${key}:`, error);
        return `<div class="text-error">Error generating input for ${key}: ${error.message || 'Unknown error'}</div>`;
    }
};

// Function to initialize settings modal event handlers
const initializeSettingsModal = () => {
    // Initialize UI settings event handlers
    setTimeout(() => {
        initializeUISettingsHandlers();
    }, 100); // Small delay to ensure DOM is ready
};

// Function to initialize UI settings event handlers
const initializeUISettingsHandlers = () => {
    // Theme toggle handler - no UI preview, just like other settings
    // Theme will only be applied when save button is clicked

    // Timezone handlers
    const timezoneSelect = document.getElementById('modal-timezone-select');
    const timezoneAdd = document.getElementById('modal-timezone-add');
    const timezoneRemove = document.getElementById('modal-timezone-remove');
    const timezoneInput = document.getElementById('modal-timezone-input');

    if (timezoneAdd && timezoneInput) {
        timezoneAdd.addEventListener('click', () => {
            if (timezoneInput.style.display === 'none' || timezoneInput.style.display === '') {
                timezoneInput.style.display = 'block';
                timezoneAdd.textContent = '✓';
                timezoneInput.focus();
            } else {
                timezoneInput.style.display = 'none';
                timezoneAdd.textContent = '+';
            }
        });

        timezoneInput.addEventListener('keypress', async (e) => {
            if (e.key === 'Enter') {
                const newTimezone = timezoneInput.value.trim();
                if (newTimezone) {
                    try {
                        // Validate timezone
                        const testDate = new Date();
                        testDate.toLocaleString('en-US', {timeZone: newTimezone});

                        // Add to select options
                        const option = document.createElement('option');
                        option.value = newTimezone;
                        option.textContent = newTimezone;
                        option.selected = true;
                        timezoneSelect.appendChild(option);

                        // Update remove button visibility
                        if (timezoneRemove) {
                            timezoneRemove.style.visibility = 'visible';
                        }

                        timezoneInput.value = '';
                        timezoneInput.style.display = 'none';
                        timezoneAdd.textContent = '+';
                    } catch {
                        timezoneInput.classList.add('input-error');
                        setTimeout(() => {
                            timezoneInput.classList.remove('input-error');
                        }, 3000);
                    }
                }
            }
        });
    }

    if (timezoneSelect && timezoneRemove) {
        timezoneSelect.addEventListener('change', () => {
            const currentTimezone = timezoneSelect.value;
            timezoneRemove.style.visibility = currentTimezone !== 'Europe/Riga' ? 'visible' : 'hidden';
        });

        timezoneRemove.addEventListener('click', () => {
            const currentTimezone = timezoneSelect.value;
            if (currentTimezone !== 'Europe/Riga') {
                const option = timezoneSelect.querySelector(`option[value="${currentTimezone}"]`);
                if (option) {
                    option.remove();
                }
                timezoneSelect.value = 'Europe/Riga';
                timezoneRemove.style.visibility = 'hidden';
            }
        });
    }
};

// Global function to save global settings only
window.saveGlobalSettings = async () => {
    try {
        const schema = await window.api.getSettingsSchema();

        // Save challenge-related global defaults
        for (const key of Object.keys(schema)) {
            const value = getInputValue(key, schema[key], '');
            if (value !== null) {
                await window.api.setGlobalDefault(key, value);
            }
        }

        // Save UI settings
        await saveUISettings();

        closeSettingsModal();

        // Refresh challenges to apply new settings
        const newTimezone = document.getElementById('modal-timezone-select')?.value || 'Europe/Riga';
        await loadChallenges(newTimezone, autovoteRunning);

    } catch (error) {
        console.error('Error saving global settings:', error);
    }
};

// Function to save UI settings
const saveUISettings = async () => {
    try {
        console.log('💾 Saving UI settings in batch...');
        const uiUpdates = {};

        // Collect theme
        const themeToggle = document.getElementById('modal-theme-toggle');
        if (themeToggle) {
            uiUpdates.theme = themeToggle.checked ? 'dark' : 'light';
        }

        // Collect language  
        const languageSelect = document.getElementById('modal-language-select');
        if (languageSelect) {
            uiUpdates.language = languageSelect.value;
        }

        // Collect timezone
        const timezoneSelect = document.getElementById('modal-timezone-select');
        if (timezoneSelect) {
            uiUpdates.timezone = timezoneSelect.value;

            // Handle custom timezones
            const customTimezones = [];
            Array.from(timezoneSelect.options).forEach(option => {
                if (option.value !== 'Europe/Riga') {
                    customTimezones.push(option.value);
                }
            });
            uiUpdates.customTimezones = customTimezones;
        }

        // Collect stay logged in
        const stayLoggedInCheckbox = document.getElementById('modal-stay-logged-in');
        if (stayLoggedInCheckbox) {
            uiUpdates.stayLoggedIn = stayLoggedInCheckbox.checked;
        }

        // Save all UI settings at once
        if (Object.keys(uiUpdates).length > 0) {
            await window.api.saveSettings(uiUpdates);
            console.log('✅ UI settings saved:', Object.keys(uiUpdates));

            // Apply language change if needed
            if (uiUpdates.language) {
                await translationManager.setLanguage(uiUpdates.language);
            }

            // Apply theme change if needed
            if (uiUpdates.theme) {
                document.documentElement.setAttribute('data-theme', uiUpdates.theme);
                console.log('🎨 Applied theme after save:', uiUpdates.theme);
            }
        }

        // Update the main page UI controls that are still visible
        updateMainPageUIControls();

    } catch (error) {
        console.error('Error saving UI settings:', error);
    }
};

// Function to update main page UI controls after settings change
const updateMainPageUIControls = async () => {
    try {
        const settings = await window.api.getSettings();

        // Update mock status (this is still in header)
        updateSettingsDisplay(settings);


        // Update timezone on the hidden timezone select (for compatibility)
        const hiddenTimezoneSelect = document.getElementById('timezone-select');
        if (hiddenTimezoneSelect && settings.timezone) {
            hiddenTimezoneSelect.value = settings.timezone;
        }

    } catch (error) {
        console.error('Error updating main page UI controls:', error);
    }
};

// Keep the old saveAllSettings for backward compatibility (if needed elsewhere)
window.saveAllSettings = window.saveGlobalSettings;

// Function to get input value based on setting type
const getInputValue = (key, config, challengeId) => {
    const inputId = challengeId ? `${key}-${challengeId}` : `global-${key}`;

    switch (config.type) {
    case 'time': {
        const hoursEl = document.getElementById(`${inputId}-hours`);
        const minutesEl = document.getElementById(`${inputId}-minutes`);
        if (hoursEl && minutesEl) {
            const hours = parseInt(hoursEl.value) || 0;
            const minutes = parseInt(minutesEl.value) || 0;
            return (hours * 3600) + (minutes * 60);
        }
        break;
    }

    case 'boolean': {
        const checkboxEl = document.getElementById(inputId);
        if (checkboxEl) {
            return checkboxEl.checked;
        }
        break;
    }

    case 'number':
    default: {
        const numberEl = document.getElementById(inputId);
        if (numberEl) {
            return parseInt(numberEl.value) || 0;
        }
        break;
    }
    }

    return null;
};

// Global function to reset challenge override
window.resetChallengeOverride = async (settingKey, challengeId) => {
    try {
        // Get the global default value
        const globalValue = await window.api.getGlobalDefault(settingKey);
        const schema = await window.api.getSettingsSchema();
        const config = schema[settingKey];

        if (config) {
            const inputId = `${settingKey}-${challengeId}`;

            switch (config.type) {
            case 'time': {
                const hours = Math.floor(globalValue / 3600);
                const minutes = Math.floor((globalValue % 3600) / 60);
                const hoursEl = document.getElementById(`${inputId}-hours`);
                const minutesEl = document.getElementById(`${inputId}-minutes`);
                if (hoursEl && minutesEl) {
                    hoursEl.value = hours;
                    minutesEl.value = minutes;
                    hoursEl.classList.remove('input-warning');
                    minutesEl.classList.remove('input-warning');
                }
                break;
            }

            case 'boolean': {
                const checkboxEl = document.getElementById(inputId);
                if (checkboxEl) {
                    checkboxEl.checked = globalValue;
                    checkboxEl.classList.remove('input-warning');
                }
                break;
            }

            case 'number':
            default: {
                const numberEl = document.getElementById(inputId);
                if (numberEl) {
                    numberEl.value = globalValue;
                    numberEl.classList.remove('input-warning');
                }
                break;
            }
            }

            // Update the remove button visibility since we've reset to global default
            updateRemoveButton();
        }

    } catch (error) {
        console.error('Error resetting challenge override:', error);
    }
};

// Global function to close settings modal
window.closeSettingsModal = () => {
    const modal = document.querySelector('.modal');
    if (modal) {
        modal.remove();
    }
};

// Global function to open challenge-specific settings modal
window.openChallengeSettingsModal = async (challengeId, challengeTitle) => {
    try {
        // Get the settings schema
        const schema = await window.api.getSettingsSchema();

        if (!schema || Object.keys(schema).length === 0) {
            console.error('No schema available');
            alert('Settings schema not available. Please try again.');
            return;
        }

        // Load current values for this challenge
        const challengeSettings = {};
        const globalDefaults = {};

        for (const key of Object.keys(schema)) {
            try {
                globalDefaults[key] = await window.api.getGlobalDefault(key);
                challengeSettings[key] = await window.api.getChallengeOverride(key, challengeId.toString());
            } catch (error) {
                console.warn(`Error loading setting ${key}:`, error);
                globalDefaults[key] = schema[key].default;
                challengeSettings[key] = null;
            }
        }

        // Create modal HTML
        const modalHtml = await generateChallengeSettingsModalHtml(challengeId, challengeTitle, schema, globalDefaults, challengeSettings);

        // Add modal to page
        document.body.insertAdjacentHTML('beforeend', modalHtml);

        // Initialize modal event handlers
        initializeChallengeSettingsModal(challengeId, schema);

    } catch (error) {
        console.error('Error opening challenge settings modal:', error);
        alert('Failed to open challenge settings modal. Check console for details.');
    }
};

// Function to generate challenge-specific settings modal HTML
const generateChallengeSettingsModalHtml = async (challengeId, challengeTitle, schema, globalDefaults, challengeSettings) => {
    let settingsHtml = '';

    for (const [key, config] of Object.entries(schema)) {
        const hasOverride = challengeSettings[key] !== null;
        const currentValue = hasOverride ? challengeSettings[key] : globalDefaults[key];
        const globalValue = globalDefaults[key];

        const inputHtml = generateInputHtml(key, config, currentValue, challengeId, hasOverride);

        try {
            const labelText = translationManager.t(config.label);
            const descText = translationManager.t(config.description);

            settingsHtml += `
                <div class="form-control mb-4">
                    <label class="label">
                        <span class="label-text font-medium" data-translate="${config.label}">${labelText}</span>
                        ${hasOverride ? `<span class="badge badge-warning badge-xs ml-2" data-translate="app.override">${translationManager.t('app.override')}</span>` : `<span class="badge badge-ghost badge-xs ml-2" data-translate="app.global">${translationManager.t('app.global')}</span>`}
                    </label>
                    <p class="text-xs text-base-content/60 mb-2" data-translate="${config.description}">${descText}</p>
                    <div class="flex items-center gap-2">
                        ${inputHtml}
                        ${hasOverride ? '' : `<span class="text-xs text-base-content/40">(${translationManager.t('common.global')} ${formatValue(config, globalValue)})</span>`}
                    </div>
                </div>
            `;
        } catch (error) {
            console.error(`Error generating HTML for challenge setting ${key}:`, error);
            settingsHtml += `
                <div class="form-control mb-4">
                    <label class="label">
                        <span class="label-text font-medium">${key}</span>
                        ${hasOverride ? `<span class="badge badge-warning badge-xs ml-2" data-translate="app.override">${translationManager.t('app.override')}</span>` : `<span class="badge badge-ghost badge-xs ml-2" data-translate="app.global">${translationManager.t('app.global')}</span>`}
                    </label>
                    <p class="text-xs text-base-content/60 mb-2">${config.description || 'No description'}</p>
                    <div class="flex items-center gap-2">
                        ${inputHtml}
                    </div>
                </div>
            `;
        }
    }

    return `
        <div class="modal modal-open">
            <div class="modal-box max-w-2xl">
                <h3 class="font-bold text-lg mb-4">
                    <svg class="w-5 h-5 inline mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                    </svg>
                    Settings: ${challengeTitle}
                </h3>
                
                <div class="space-y-4">
                    ${settingsHtml}
                </div>
                
                <div class="modal-action">
                    <button class="btn btn-latvian" onclick="saveChallengeSettings('${challengeId}')">
                        <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                        </svg>
                        <span data-translate="app.save">${translationManager.t('app.save')}</span>
                    </button>
                    <button class="btn" onclick="closeSettingsModal()">
                        <span data-translate="app.cancel">${translationManager.t('app.cancel')}</span>
                    </button>
                </div>
            </div>
        </div>
    `;
};

// Function to format a value for display
const formatValue = (config, value) => {
    switch (config.type) {
    case 'time': {
        const hours = Math.floor(value / 3600);
        const minutes = Math.floor((value % 3600) / 60);
        return `${hours}h ${minutes}m`;
    }
    case 'boolean': {
        return value ? translationManager.t('common.yes') : translationManager.t('common.no');
    }
    default: {
        return value;
    }
    }
};

// Function to initialize challenge settings modal event handlers
const initializeChallengeSettingsModal = () => {
    // No special initialization needed for now
};

// Global function to save challenge settings
window.saveChallengeSettings = async (challengeId) => {
    try {
        const schema = await window.api.getSettingsSchema();

        // Get current overrides to know what to remove
        const currentOverrides = {};
        for (const key of Object.keys(schema)) {
            try {
                const currentOverride = await window.api.getChallengeOverride(key, challengeId);
                if (currentOverride !== null) {
                    currentOverrides[key] = currentOverride;
                }
            } catch {
                // Ignore errors for non-existent overrides
            }
        }

        // Collect all overrides efficiently, only saving values that differ from global defaults
        const overrides = {};
        const overridesToRemove = [];

        for (const key of Object.keys(schema)) {
            const value = getInputValue(key, schema[key], challengeId);
            if (value !== null) {
                // Get the global default to compare
                const globalDefault = await window.api.getGlobalDefault(key);

                if (value !== globalDefault) {
                    // Value differs from global default - save as override
                    overrides[key] = value;
                } else if (currentOverrides[key] !== undefined) {
                    // Value equals global default but there was a previous override - remove it
                    overridesToRemove.push(key);
                }
                // If value equals global default and there was no previous override, do nothing
            }
        }


        for (const key of overridesToRemove) {
            await window.api.removeChallengeOverride(key, challengeId);
        }

        // Save new overrides
        if (Object.keys(overrides).length > 0) {
            await window.api.setChallengeOverrides(challengeId, overrides);
        }

        closeSettingsModal();

        // Refresh challenges to apply new settings
        const currentTimezone = document.getElementById('timezone-select')?.value || 'local';
        await loadChallenges(currentTimezone, autovoteRunning);

    } catch (error) {
        console.error('Error saving challenge settings:', error);
    }
};

// Global function to open challenge URL in default browser
window.openChallengeUrl = (url) => {
    window.api.openExternalUrl(`https://gurushots.com/challenge/${url}`);
};

// Wait for the DOM to be fully loaded
document.addEventListener('DOMContentLoaded', async () => {
    // Show log file location
    const logFile = await window.api.getLogFile();
    console.log('📝 Log file location:', logFile);

    // Settings cleanup is now handled automatically in settings.js during loadSettings()

    // Load initial settings AFTER cleanup
    let settings = await window.api.getSettings();

    // Apply initial theme with current settings
    document.documentElement.setAttribute('data-theme', settings.theme);
    console.log('🎨 Applied theme:', settings.theme);

    // Get the UI elements
    const logoutBtn = document.getElementById('logoutBtn');
    const settingsBtn = document.getElementById('settingsBtn');
    const themeToggle = document.getElementById('themeToggle');
    const refreshBtn = document.getElementById('refresh-challenges');
    const timezoneSelect = document.getElementById('timezone-select');
    const currentLanguageSpan = document.getElementById('current-language');
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

    // Add click event listener to the settings button
    settingsBtn.addEventListener('click', () => {
        openSettingsModal();
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

    // Handle theme toggle change - just update UI, don't auto-save
    themeToggle.addEventListener('change', async () => {
        const newTheme = themeToggle.checked ? 'dark' : 'light';

        // Update the theme immediately for responsive UI
        document.documentElement.setAttribute('data-theme', newTheme);


        updateSettingsDisplay(settings);


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

                await loadChallenges('local', autovoteRunning);
                return;
            }

            // Validate timezone
            try {
                const testDate = new Date();
                testDate.toLocaleString('en-US', {timeZone: newTimezone});

                // Valid timezone - just update UI (saved through settings modal)

                // Add the new timezone as an option if it doesn't exist
                const existingOption = timezoneSelect.querySelector(`option[value="${newTimezone}"]`);
                if (!existingOption) {
                    const option = document.createElement('option');
                    option.value = newTimezone;
                    option.textContent = newTimezone;
                    timezoneSelect.appendChild(option);
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

            // Set back to Europe/Riga  
            timezoneSelect.value = 'Europe/Riga';

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

// Global function to boost a specific entry
window.boostEntry = async (challengeId, imageId, rank) => {
    try {
        console.log(`🚀 Boosting entry: Challenge ${challengeId}, Image ${imageId}, Rank ${rank}`);

        // Show loading state on the button
        const button = document.querySelector(`[data-challenge-id="${challengeId}"][data-image-id="${imageId}"]`);
        if (button) {
            const originalText = button.innerHTML;
            button.disabled = true;
            button.innerHTML = '<span class="loading loading-spinner loading-xs"></span>';

            // Call the API to apply boost
            const result = await window.api.applyBoostToEntry(challengeId, imageId);

            if (result && result.success) {
                console.log('✅ Boost applied successfully');
                // Update the button to show success
                button.innerHTML = '✅';
                button.className = 'btn btn-xs btn-success ml-1';

                // Refresh challenges to show updated state
                setTimeout(() => {
                    loadChallenges(document.getElementById('timezone-select').value, false);
                }, 1000);
            } else {
                console.error('❌ Failed to apply boost:', result?.error || 'Unknown error');
                // Reset button on error
                button.disabled = false;
                button.innerHTML = originalText;

                // Show error message
                alert(`Failed to apply boost: ${result?.error || 'Unknown error'}`);
            }
        }
    } catch (error) {
        console.error('❌ Error boosting entry:', error);
        alert(`Error boosting entry: ${error.message || 'Unknown error'}`);

        // Reset button on error
        const button = document.querySelector(`[data-challenge-id="${challengeId}"][data-image-id="${imageId}"]`);
        if (button) {
            button.disabled = false;
            button.innerHTML = '🚀';
        }
    }
};