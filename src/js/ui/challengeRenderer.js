import { formatTimeRemaining, formatEndTime, getBoostStatus, getTurboStatus, getLevelStatus, initializeTimers } from './formatters.js';

const translationManager = window.translationManager;

export const renderChallenges = async (challenges, timezone = 'local', autovoteRunning = false) => {
    await window.api.logDebug('🎨 Rendering challenges in UI');

    const container = document.getElementById('challenges-container');

    if (!challenges || challenges.length === 0) {
        container.innerHTML = `<div class="text-center py-4 text-base-content/60">${translationManager.t('app.pleaseLogin')}</div>`;
        await window.api.logDebug('No challenges to display');
        return;
    }

    // Sort challenges by ending time (shortest time remaining first)
    const sortedChallenges = challenges.sort((a, b) => {
        const timeA = a.close_time - Math.floor(Date.now() / 1000);
        const timeB = b.close_time - Math.floor(Date.now() / 1000);
        return timeA - timeB;
    });

    const challengesHtmlArray = await Promise.all(sortedChallenges.map(async challenge => {
        // Log challenge processing for debugging
        await window.api.logDebug(`🎨 Processing challenge: ${challenge.title}`);

        const timeRemaining = formatTimeRemaining(challenge.close_time);
        const endTime = formatEndTime(challenge.close_time, timezone);
        const boostStatus = getBoostStatus(challenge.member.boost);
        const turboStatus = getTurboStatus(challenge.member.turbo);
        const exposureFactor = challenge.member.ranking.exposure.exposure_factor;
        const entries = challenge.member.ranking.entries;

        // Check if this challenge has any custom settings overrides
        let hasCustomSettings = false;
        try {
            const schema = await window.api.getSettingsSchema();
            for (const [key, config] of Object.entries(schema)) {
                // Only check settings that support per-challenge overrides
                if (!config.perChallenge) {
                    continue;
                }
                const override = await window.api.getChallengeOverride(key, challenge.id.toString());
                if (override !== null) {
                    hasCustomSettings = true;
                    break;
                }
            }
        } catch (error) {
            await window.api.logWarning(`Error checking for custom settings: ${error.message || error}`);
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
            if (challenge.ranking_levels && userProgress && userProgress.level !== undefined && challenge.type !== 'flash') {
                const currentLevel = userProgress.level;
                const nextLevel = currentLevel + 1;
                const nextLevelKey = `level_${nextLevel}`;

                if (challenge.ranking_levels[nextLevelKey]) {
                    const votesNeeded = challenge.ranking_levels[nextLevelKey] - userProgress.votes;

                    // Get next level name based on level number
                    const getLevelName = (level) => {
                        switch (level) {
                        case 1:
                            return 'POPULAR';
                        case 2:
                            return 'SKILLED';
                        case 3:
                            return 'PREMIER';
                        case 4:
                            return 'ELITE';
                        case 5:
                            return 'ALL STAR';
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

        // Create entries display with detailed information
        let entriesHtml = entries.map(entry => {
            // Show boost icon only if entry is actually boosted
            const isEntryBoosted = entry.boost === 1 || entry.boosted === true;
            const boostIcon = isEntryBoosted ? '🚀' : '';
            const guruIcon = entry.guru_pick ? '⭐' : '';
            // Show camera only for regular entries (no turbo, no boost, no guru pick)
            const isRegularEntry = !entry.turbo && !isEntryBoosted && !entry.guru_pick;
            const turboIcon = entry.turbo ? '⚡' : (isRegularEntry ? '📷' : '');
            // Determine entry type and appropriate color class
            let entryTypeClass = '';
            if (isEntryBoosted) {
                entryTypeClass = 'border-info text-info';
            } else if (entry.turbo) {
                entryTypeClass = 'border-warning text-warning';
            } else if (isRegularEntry) {
                entryTypeClass = 'border-success text-success';
            } else {
                // Fallback for guru pick or other special entries
                entryTypeClass = 'badge-secondary';
            }

            // Show boost button only if boost is available and entry is not already boosted
            const showBoostButton = boostStatus.text.includes('Available') && entry.boost !== 1;
            const boostButtonHtml = showBoostButton ? `
                <button class="btn btn-xs btn-success ml-1 entry-boost-btn" 
                        data-challenge-id="${challenge.id}" 
                        data-image-id="${entry.id}" 
                        data-entry-rank="${entry.rank}"
                        onclick="boostEntry(${challenge.id}, '${entry.id}', ${entry.rank})">
                    🚀
                </button>
            ` : '';

            return `
                <div class="badge badge-outline ${entryTypeClass} flex items-center">
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
        const settingsButtonHtml = challenge.type !== 'flash' ? `
            <button class="challenge-settings-btn btn btn-ghost btn-sm" data-challenge-id="${challenge.id}" data-challenge-title="${challenge.title}" title="Challenge Settings">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                </svg>
            </button>
        ` : '';

        return `
            <div class="border rounded-lg p-3 mb-3 bg-base-100">
                <div class="space-y-2">
                    <!-- Title and Description -->
                    <div class="flex justify-between items-start">
                        <div class="flex-1">
                            <h3 class="font-bold text-base">${challenge.title}</h3>
                            <div class="text-xs text-base-content/60 challenge-welcome-message" data-welcome-message="${challenge.welcome_message.replace(/"/g, '&quot;')}"></div>
                            <!-- Challenge Type Badges -->
                            <div class="flex gap-1 mt-1">
                                ${challenge.type ? `<span class="badge badge-xs badge-warning">${challenge.type.toUpperCase()}</span>` : 
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
                                <span class="badge badge-xs ${getLevelStatus(userProgress.level, userProgress.level_name).colorClass}">
                                    ${userProgress.level_name} ${userProgress.level}
                                </span>
                            </div>
                            <div class="flex justify-between text-xs mb-1">
                                <span>${translationManager.t('app.rank')} ${userProgress.rank} ${translationManager.t('app.of')} ${challengeStats.players}</span>
                                <span>${userProgress.votes} ${translationManager.t('app.votes')}</span>
                            </div>
                            <progress class="progress progress-latvian w-full" value="${userProgress.percent}" max="100"></progress>
                            ${challenge.type !== 'flash' ? `
                            <div class="text-xs text-base-content/60 mt-1">${userProgress.next_message}</div>
                            ` : ''}
                            ${nextLevelInfo ? `
                                <div class="text-xs text-base-content/60 mt-1">
                                    ${translationManager.t('app.next')}: ${nextLevelInfo.levelName} (${nextLevelInfo.votesNeeded} ${translationManager.t('app.votesNeeded')})
                                </div>
                            ` : ''}
                        </div>
                    ` : ''}
                    
                    <!-- Challenge Stats -->
                    <div class="grid grid-cols-6 gap-2 text-xs">
                        <div class="text-center p-2 bg-base-200 rounded">
                            <div class="font-medium">${translationManager.t('app.time')}</div>
                            <div class="${timeRemaining === 'Ended' ? 'text-error' : 'text-success'}" data-end-time="${challenge.close_time}">${timeRemaining}</div>
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
                            <div class="${boostStatus.colorClass}">${boostStatus.text}</div>
                        </div>
                        <div class="text-center p-2 bg-base-200 rounded">
                            <div class="font-medium">${translationManager.t('app.turbo')}</div>
                            <div class="${turboStatus.colorClass}">${turboStatus.text}</div>
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

    // Set welcome messages as HTML
    document.querySelectorAll('.challenge-welcome-message').forEach(element => {
        const welcomeMessage = element.dataset.welcomeMessage;
        if (welcomeMessage) {
            element.innerHTML = welcomeMessage;
        }
    });

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
                window.singleVoteRunning = true;
                const refreshBtn = document.getElementById('refresh-challenges');
                if (refreshBtn) {
                    refreshBtn.classList.add('hidden');
                }

                try {
                    // Call the manual voting function for this specific challenge (bypasses all thresholds)
                    const result = await window.api.voteOnChallengeManual(challengeId, challengeTitle);

                    if (result && result.success) {
                        // Re-enable immediately and show refresh button
                        btn.disabled = false;
                        btn.innerHTML = originalText;
                        btn.className = 'challenge-vote-btn btn btn-latvian btn-sm';

                        // Show refresh button again immediately
                        window.singleVoteRunning = false;
                        if (refreshBtn && !autovoteRunning) {
                            refreshBtn.classList.remove('hidden');
                        }

                        // Refresh challenges in background after successful vote
                        const timezone = await window.api.getSetting('timezone');
                        window.loadChallenges(timezone, autovoteRunning); // No await - let it run in background
                    } else {
                        // Show error feedback for API error
                        await window.api.logError(`Voting failed: ${result?.error || 'Unknown error'}`);

                        // Re-enable immediately and show refresh button
                        btn.disabled = false;
                        btn.innerHTML = originalText;
                        btn.className = 'challenge-vote-btn btn btn-latvian btn-sm';

                        // Show refresh button again immediately
                        window.singleVoteRunning = false;
                        if (refreshBtn && !autovoteRunning) {
                            refreshBtn.classList.remove('hidden');
                        }
                    }

                } catch (error) {
                    await window.api.logError(`Error voting on challenge: ${error.message || error}`);

                    // Re-enable immediately and show refresh button
                    btn.disabled = false;
                    btn.innerHTML = originalText;
                    btn.className = 'challenge-vote-btn btn btn-latvian btn-sm';

                    // Show refresh button again immediately
                    window.singleVoteRunning = false;
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
            window.openChallengeSettingsModal(challengeId, challengeTitle);
        });
    });

    // Add event listener to Vote All button (only when autovote is not running)
    if (!autovoteRunning) {
        const voteAllBtn = document.getElementById('vote-all-challenges');
        if (voteAllBtn) {
            // Ensure button is visible when autovote is not running
            voteAllBtn.classList.remove('hidden');
            // Remove any existing event listeners to prevent duplicates
            const newVoteAllBtn = voteAllBtn.cloneNode(true);
            voteAllBtn.parentNode.replaceChild(newVoteAllBtn, voteAllBtn);

            newVoteAllBtn.addEventListener('click', async (e) => {
                // Disable button and show loading
                const btn = e.target.closest('#vote-all-challenges');
                const originalText = btn.innerHTML;
                btn.disabled = true;
                btn.innerHTML = `
                    <span class="loading loading-spinner loading-xs"></span>
                    ${translationManager.t('app.votingAll')}
                `;

                // Hide refresh button while Vote All is running
                window.singleVoteRunning = true;
                const refreshBtn = document.getElementById('refresh-challenges');
                if (refreshBtn) {
                    refreshBtn.classList.add('hidden');
                }

                try {
                    // Call the Vote All function (votes on all challenges below 100%)
                    const result = await window.api.voteAllChallengesManual();

                    if (result && result.success) {
                        // Re-enable immediately and show refresh button
                        btn.disabled = false;
                        btn.innerHTML = originalText;
                        btn.className = 'btn btn-latvian btn-sm';

                        // Show refresh button again
                        window.singleVoteRunning = false;
                        if (refreshBtn && !window.autovoteRunning) {
                            refreshBtn.classList.remove('hidden');
                        }

                        // Refresh challenges in background after successful vote all
                        const timezone = await window.api.getSetting('timezone');
                        window.loadChallenges(timezone, autovoteRunning); // No await - let it run in background

                    } else {
                        // Show error feedback for API error
                        await window.api.logError(`Vote All failed: ${result?.error || 'Unknown error'}`);

                        // Re-enable immediately and show refresh button
                        btn.disabled = false;
                        btn.innerHTML = originalText;
                        btn.className = 'btn btn-latvian btn-sm';

                        // Show refresh button again
                        window.singleVoteRunning = false;
                        if (refreshBtn && !window.autovoteRunning) {
                            refreshBtn.classList.remove('hidden');
                        }
                    }

                } catch (error) {
                    await window.api.logError(`Error during Vote All: ${error.message || error}`);

                    // Re-enable immediately and show refresh button
                    btn.disabled = false;
                    btn.innerHTML = originalText;
                    btn.className = 'btn btn-latvian btn-sm';

                    // Show refresh button again
                    window.singleVoteRunning = false;
                    if (refreshBtn && !window.autovoteRunning) {
                        refreshBtn.classList.remove('hidden');
                    }
                }
            });
        }
    } else {
        // Hide Vote All button when autovote is running
        const voteAllBtn = document.getElementById('vote-all-challenges');
        if (voteAllBtn) {
            voteAllBtn.classList.add('hidden');
        }
    }
    
    // Initialize timers for all challenge cards
    initializeTimers();
};