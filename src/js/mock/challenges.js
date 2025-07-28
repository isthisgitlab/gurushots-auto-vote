/**
 * GuruShots Auto Voter - Mock Challenge Data
 * 
 * Mock responses for challenge operations
 */

/**
 * Generate dynamic mock challenges with realistic exposure factors
 */
const generateMockChallenges = () => {
    const now = Math.floor(Date.now() / 1000);
    
    return {
        challenges: [
            {
                id: 1001,
                title: 'Street Photography',
                welcome_message: 'Capture the essence of urban life',
                url: 'street-photography-2024',
                start_time: now - 86400, // Started 1 day ago
                close_time: now + 86400, // Ends in 1 day
                status: 'active',
                entries: 1536,
                players: 921,
                votes: 259120,
                max_photo_submits: 2,
                badge: 'speed',
                type: 'default',
                tags: ['2 photos', 'No comm', 'Turbo'],
                vote_minimum_players: 200,
                prizes_worth: 180,
                ranking_levels: {
                    level_0: 0,
                    level_1: 50,
                    level_2: 250,
                    level_3: 900,
                    level_4: 1900,
                    level_5: 3800,
                },
                boost_enable: true,
                turbo_enable: true,
                fill_enable: true,
                swap_enable: true,
                top_photo_enable: true,
                time_left: {
                    days: 1,
                    hours: 12,
                    minutes: 30,
                    seconds: 45,
                },
                member: {
                    time_joined: now - 86400,
                    boost: {
                        state: 'AVAILABLE',
                        timeout: now + 3600, // Available for 1 hour
                    },
                    turbo: {
                        max_selections: 10,
                        turbo_unlock_type: 'COINS',
                        turbo_unlock_amount: 250,
                        required_selections: 6,
                        state: 'FREE',
                        time_to_open: null,
                    },
                    ranking: {
                        total: {
                            votes: 232,
                            rank: 264,
                            level: 1,
                            level_name: 'POPULAR',
                            level_rank: 17,
                            next: 18,
                            percent: 93.17,
                            exposure: 85,
                            points: 30,
                            guru_picks: 0,
                            next_message: '18 votes to next level',
                        },
                        exposure: {
                            exposure_factor: Math.min(85, Math.floor(Math.random() * 20) + 70), // 70-85%
                            vote_exposure_factor: 40,
                            vote_ratio: 2.22,
                        },
                        entries: [
                            {
                                id: 'entry_001',
                                votes: 156,
                                rank: 94,
                                member_id: 'mock_user_001',
                                adult: false,
                                event_id: 4000918060092,
                                guru_pick: false,
                                boost: -1,
                                turbo: false,
                                boosting: false,
                                boosted: false,
                            },
                            {
                                id: 'entry_002',
                                votes: 76,
                                rank: 156,
                                member_id: 'mock_user_001',
                                adult: false,
                                event_id: 4000918060092,
                                guru_pick: false,
                                boost: 0,
                                turbo: true,
                                boosting: false,
                                boosted: false,
                            },
                        ],
                    },
                },
            },
            {
                id: 1002,
                title: 'Portrait Photography',
                welcome_message: 'Beautiful portraits that tell a story',
                url: 'portrait-photography-2024',
                start_time: now - 172800, // Started 2 days ago
                close_time: now + 172800, // Ends in 2 days
                status: 'active',
                entries: 2847,
                players: 2156,
                votes: 1847560,
                max_photo_submits: 1,
                badge: '',
                type: 'default',
                tags: ['1 photo', 'No comm'],
                vote_minimum_players: 200,
                prizes_worth: 160,
                ranking_levels: {
                    level_0: 0,
                    level_1: 100,
                    level_2: 500,
                    level_3: 1500,
                    level_4: 3000,
                    level_5: 6000,
                },
                boost_enable: false,
                turbo_enable: true,
                fill_enable: true,
                swap_enable: true,
                top_photo_enable: true,
                time_left: {
                    days: 2,
                    hours: 8,
                    minutes: 15,
                    seconds: 30,
                },
                member: {
                    time_joined: now - 172800,
                    boost: {
                        state: 'USED',
                        timeout: 0,
                    },
                    turbo: {
                        max_selections: 10,
                        turbo_unlock_type: 'COINS',
                        turbo_unlock_amount: 250,
                        required_selections: 6,
                        state: 'FREE',
                        time_to_open: null,
                    },
                    ranking: {
                        total: {
                            votes: 445,
                            rank: 89,
                            level: 2,
                            level_name: 'ELITE',
                            level_rank: 12,
                            next: 13,
                            percent: 87.45,
                            exposure: 100,
                            points: 65,
                            guru_picks: 1,
                            next_message: '12 votes to next level',
                        },
                        exposure: {
                            exposure_factor: Math.min(100, Math.floor(Math.random() * 10) + 90), // 90-100%
                            vote_exposure_factor: 100,
                            vote_ratio: 1.85,
                        },
                        entries: [
                            {
                                id: 'entry_003',
                                votes: 445,
                                rank: 89,
                                member_id: 'mock_user_001',
                                adult: false,
                                event_id: 4000918060093,
                                guru_pick: true,
                                boost: 1,
                                turbo: false,
                                boosting: false,
                                boosted: true,
                            },
                        ],
                    },
                },
            },
            {
                id: 1003,
                title: 'Landscape Photography',
                welcome_message: 'Breathtaking landscapes from around the world',
                url: 'landscape-photography-2024',
                start_time: now + 3600, // Starts in 1 hour
                close_time: now + 604800, // Ends in 7 days
                status: 'upcoming',
                entries: 0,
                players: 0,
                votes: 0,
                max_photo_submits: 2,
                badge: '',
                type: 'default',
                tags: ['2 photos', 'No comm'],
                vote_minimum_players: 200,
                prizes_worth: 200,
                ranking_levels: {
                    level_0: 0,
                    level_1: 75,
                    level_2: 300,
                    level_3: 1200,
                    level_4: 2500,
                    level_5: 5000,
                },
                boost_enable: true,
                turbo_enable: true,
                fill_enable: true,
                swap_enable: true,
                top_photo_enable: true,
                time_left: {
                    days: 7,
                    hours: 0,
                    minutes: 0,
                    seconds: 0,
                },
                member: {
                    time_joined: 0,
                    boost: {
                        state: 'UNAVAILABLE',
                        timeout: 0,
                    },
                    turbo: {
                        max_selections: 10,
                        turbo_unlock_type: 'COINS',
                        turbo_unlock_amount: 250,
                        required_selections: 6,
                        state: 'LOCKED',
                        time_to_open: null,
                    },
                    ranking: {
                        total: {
                            votes: 0,
                            rank: 0,
                            level: 0,
                            level_name: 'NONE',
                            level_rank: 0,
                            next: 1,
                            percent: 0,
                            exposure: 0,
                            points: 0,
                            guru_picks: 0,
                            next_message: 'Challenge not started',
                        },
                        exposure: {
                            exposure_factor: 0,
                            vote_exposure_factor: 0,
                            vote_ratio: 0,
                        },
                        entries: [],
                    },
                },
            },
            {
                id: 1004,
                title: 'Macro Photography',
                welcome_message: 'Discover the beauty in small details',
                url: 'macro-photography-2024',
                start_time: now - 43200, // Started 12 hours ago
                close_time: now + 43200, // Ends in 12 hours
                status: 'active',
                entries: 892,
                players: 654,
                votes: 156780,
                max_photo_submits: 1,
                badge: 'speed',
                type: 'speed',
                tags: ['1 photo', 'Speed', 'No comm'],
                vote_minimum_players: 200,
                prizes_worth: 140,
                ranking_levels: {
                    level_0: 0,
                    level_1: 25,
                    level_2: 150,
                    level_3: 600,
                    level_4: 1200,
                    level_5: 2500,
                },
                boost_enable: true,
                turbo_enable: true,
                fill_enable: true,
                swap_enable: true,
                top_photo_enable: true,
                time_left: {
                    days: 0,
                    hours: 12,
                    minutes: 0,
                    seconds: 0,
                },
                member: {
                    time_joined: now - 43200,
                    boost: {
                        state: 'AVAILABLE',
                        timeout: now + 1800, // Available for 30 minutes
                    },
                    turbo: {
                        max_selections: 10,
                        turbo_unlock_type: 'COINS',
                        turbo_unlock_amount: 250,
                        required_selections: 6,
                        state: 'FREE',
                        time_to_open: null,
                    },
                    ranking: {
                        total: {
                            votes: 78,
                            rank: 156,
                            level: 1,
                            level_name: 'POPULAR',
                            level_rank: 8,
                            next: 9,
                            percent: 45.23,
                            exposure: 60,
                            points: 15,
                            guru_picks: 0,
                            next_message: '8 votes to next level',
                        },
                        exposure: {
                            exposure_factor: Math.min(60, Math.floor(Math.random() * 30) + 30), // 30-60%
                            vote_exposure_factor: 25,
                            vote_ratio: 1.45,
                        },
                        entries: [
                            {
                                id: 'entry_004',
                                votes: 78,
                                rank: 156,
                                member_id: 'mock_user_001',
                                adult: false,
                                event_id: 4000918060094,
                                guru_pick: false,
                                boost: 0,
                                turbo: false,
                                boosting: false,
                                boosted: false,
                            },
                        ],
                    },
                },
            },
            {
                id: 1005,
                title: 'Wildlife Photography',
                welcome_message: 'Capture nature in its purest form',
                url: 'wildlife-photography-2024',
                start_time: now - 21600, // Started 6 hours ago
                close_time: now + 21600, // Ends in 6 hours
                status: 'active',
                entries: 567,
                players: 423,
                votes: 89234,
                max_photo_submits: 2,
                badge: '',
                type: 'default',
                tags: ['2 photos', 'No comm'],
                vote_minimum_players: 200,
                prizes_worth: 120,
                ranking_levels: {
                    level_0: 0,
                    level_1: 30,
                    level_2: 200,
                    level_3: 800,
                    level_4: 1600,
                    level_5: 3200,
                },
                boost_enable: true,
                turbo_enable: true,
                fill_enable: true,
                swap_enable: true,
                top_photo_enable: true,
                time_left: {
                    days: 0,
                    hours: 6,
                    minutes: 0,
                    seconds: 0,
                },
                member: {
                    time_joined: now - 21600,
                    boost: {
                        state: 'AVAILABLE',
                        timeout: now + 900, // Available for 15 minutes
                    },
                    turbo: {
                        max_selections: 10,
                        turbo_unlock_type: 'COINS',
                        turbo_unlock_amount: 250,
                        required_selections: 6,
                        state: 'FREE',
                        time_to_open: null,
                    },
                    ranking: {
                        total: {
                            votes: 34,
                            rank: 234,
                            level: 1,
                            level_name: 'POPULAR',
                            level_rank: 3,
                            next: 4,
                            percent: 23.45,
                            exposure: 40,
                            points: 8,
                            guru_picks: 0,
                            next_message: '3 votes to next level',
                        },
                        exposure: {
                            exposure_factor: Math.min(40, Math.floor(Math.random() * 25) + 15), // 15-40%
                            vote_exposure_factor: 15,
                            vote_ratio: 1.12,
                        },
                        entries: [
                            {
                                id: 'entry_005',
                                votes: 34,
                                rank: 234,
                                member_id: 'mock_user_001',
                                adult: false,
                                event_id: 4000918060095,
                                guru_pick: false,
                                boost: 0,
                                turbo: true,
                                boosting: false,
                                boosted: false,
                            },
                        ],
                    },
                },
            },
            {
                id: 1006,
                title: 'Architecture Photography',
                welcome_message: 'Modern and classical architectural marvels',
                url: 'architecture-photography-2024',
                start_time: now - 7200, // Started 2 hours ago
                close_time: now + 7200, // Ends in 2 hours
                status: 'active',
                entries: 234,
                players: 189,
                votes: 45678,
                max_photo_submits: 1,
                badge: 'speed',
                type: 'speed',
                tags: ['1 photo', 'Speed', 'No comm'],
                vote_minimum_players: 200,
                prizes_worth: 100,
                ranking_levels: {
                    level_0: 0,
                    level_1: 20,
                    level_2: 100,
                    level_3: 400,
                    level_4: 800,
                    level_5: 1600,
                },
                boost_enable: true,
                turbo_enable: true,
                fill_enable: true,
                swap_enable: true,
                top_photo_enable: true,
                time_left: {
                    days: 0,
                    hours: 2,
                    minutes: 0,
                    seconds: 0,
                },
                member: {
                    time_joined: now - 7200,
                    boost: {
                        state: 'AVAILABLE',
                        timeout: now + 600, // Available for 10 minutes
                    },
                    turbo: {
                        max_selections: 10,
                        turbo_unlock_type: 'COINS',
                        turbo_unlock_amount: 250,
                        required_selections: 6,
                        state: 'FREE',
                        time_to_open: null,
                    },
                    ranking: {
                        total: {
                            votes: 12,
                            rank: 456,
                            level: 1,
                            level_name: 'POPULAR',
                            level_rank: 1,
                            next: 2,
                            percent: 12.34,
                            exposure: 25,
                            points: 3,
                            guru_picks: 0,
                            next_message: '1 vote to next level',
                        },
                        exposure: {
                            exposure_factor: Math.min(25, Math.floor(Math.random() * 20) + 5), // 5-25%
                            vote_exposure_factor: 8,
                            vote_ratio: 0.85,
                        },
                        entries: [
                            {
                                id: 'entry_006',
                                votes: 12,
                                rank: 456,
                                member_id: 'mock_user_001',
                                adult: false,
                                event_id: 4000918060096,
                                guru_pick: false,
                                boost: 0,
                                turbo: false,
                                boosting: false,
                                boosted: false,
                            },
                        ],
                    },
                },
            },
        ],
    };
};

/**
 * Mock active challenges response (now dynamic)
 */
const mockActiveChallenges = generateMockChallenges();

/**
 * Mock empty challenges response
 */
const mockEmptyChallenges = {
    challenges: [],
};

/**
 * Mock challenge details for a specific challenge
 */
const mockChallengeDetails = {
    id: 1001,
    title: 'Street Photography',
    description: 'Capture the essence of urban life',
    url: 'street-photography-2024',
    start_time: Math.floor(Date.now() / 1000) - 86400,
    end_time: Math.floor(Date.now() / 1000) + 86400,
    status: 'active',
    total_entries: 1250,
    total_votes: 8900,
    member: {
        ranking: {
            exposure: {
                exposure_factor: 75,
                max_exposure: 100,
            },
            entries: [
                {
                    id: 'entry_001',
                    image_url: 'https://example.com/photo1.jpg',
                    turbo: false,
                    rank: 15,
                    votes: 45,
                },
                {
                    id: 'entry_002',
                    image_url: 'https://example.com/photo2.jpg',
                    turbo: true,
                    rank: 8,
                    votes: 67,
                },
            ],
        },
        boost: {
            state: 'AVAILABLE',
            timeout: Math.floor(Date.now() / 1000) + 3600,
        },
    },
};

module.exports = {
    mockActiveChallenges,
    mockEmptyChallenges,
    mockChallengeDetails,
    generateMockChallenges,
}; 