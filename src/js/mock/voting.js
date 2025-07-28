/**
 * GuruShots Auto Voter - Mock Voting Data
 * 
 * Mock responses for voting operations
 */

/**
 * Generate dynamic mock vote images for different challenges
 */
const generateMockVoteImages = (challengeUrl) => {
    const photographers = [
        'John Doe', 'Jane Smith', 'Mike Johnson', 'Sarah Wilson', 'David Brown',
        'Lisa Davis', 'Tom Miller', 'Emma Taylor', 'Chris Anderson', 'Anna Garcia',
        'Robert Chen', 'Maria Rodriguez', 'James Wilson', 'Sophie Martin', 'Alex Thompson',
    ];
    
    const titles = {
        'street-photography-2024': [
            'Urban Life', 'City Lights', 'Street Market', 'Morning Commute', 'Street Art',
            'Night Scene', 'Street Portrait', 'Urban Architecture', 'Street Food', 'City Reflection',
        ],
        'portrait-photography-2024': [
            'Eyes of Wisdom', 'Smile of Joy', 'Contemplation', 'Laughing Child', 'Elderly Grace',
            'Young Dreamer', 'Artist Portrait', 'Chef at Work', 'Musician Focus', 'Dancer Movement',
        ],
        'landscape-photography-2024': [
            'Mountain Peak', 'Ocean Sunset', 'Forest Path', 'Desert Dunes', 'Alpine Lake',
            'Coastal Cliffs', 'Valley Mist', 'River Bend', 'Snowy Summit', 'Golden Fields',
        ],
        'macro-photography-2024': [
            'Dew Drop', 'Butterfly Wing', 'Flower Petals', 'Insect Eye', 'Water Droplet',
            'Leaf Veins', 'Spider Web', 'Crystal Formation', 'Feather Detail', 'Bark Texture',
        ],
        'wildlife-photography-2024': [
            'Lion Pride', 'Eagle Flight', 'Elephant Family', 'Wolf Pack', 'Dolphin Jump',
            'Tiger Stare', 'Gorilla Strength', 'Penguin Colony', 'Shark Hunt', 'Owl Wisdom',
        ],
        'architecture-photography-2024': [
            'Modern Skyscraper', 'Gothic Cathedral', 'Glass Facade', 'Stone Bridge', 'Steel Structure',
            'Ancient Temple', 'Art Deco Building', 'Minimalist Design', 'Historic Castle', 'Contemporary Museum',
        ],
    };
    
    const challengeTitles = titles[challengeUrl] || titles['street-photography-2024'];
    const images = [];
    
    // Generate 15-25 random images for voting
    const numImages = Math.floor(Math.random() * 11) + 15; // 15-25 images
    
    for (let i = 0; i < numImages; i++) {
        const photographer = photographers[Math.floor(Math.random() * photographers.length)];
        const title = challengeTitles[Math.floor(Math.random() * challengeTitles.length)];
        const ratio = (Math.random() * 3) + 3; // 3-6 ratio
        const votes = Math.floor(Math.random() * 50) + 10; // 10-60 votes
        
        images.push({
            id: `vote_img_${String(i + 1).padStart(3, '0')}`,
            image_url: `https://example.com/vote${i + 1}.jpg`,
            photographer,
            title,
            ratio: Math.round(ratio * 10) / 10, // Round to 1 decimal
            votes,
        });
    }
    
    return {
        challenge: {
            id: Math.floor(Math.random() * 9000) + 1000,
            title: challengeUrl.replace('-2024', '').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
            url: challengeUrl,
        },
        voting: {
            exposure: {
                exposure_factor: Math.floor(Math.random() * 30) + 20, // 20-50%
                max_exposure: 100,
            },
        },
        images,
    };
};

/**
 * Mock vote images response (now dynamic)
 */
const mockVoteImages = generateMockVoteImages('street-photography-2024');

/**
 * Mock empty vote images response
 */
const mockEmptyVoteImages = {
    challenge: {
        id: 1001,
        title: 'Street Photography',
        url: 'street-photography-2024',
    },
    voting: {
        exposure: {
            exposure_factor: 100,
            max_exposure: 100,
        },
    },
    images: [],
};

/**
 * Mock vote submission success response
 */
const mockVoteSubmissionSuccess = {
    success: true,
    message: 'Votes submitted successfully',
    challenge_id: 1001,
    votes_submitted: 5,
    new_exposure_factor: 100,
    rewards: {
        points_earned: 25,
        experience_gained: 10,
    },
};

/**
 * Mock vote submission failure response
 */
const mockVoteSubmissionFailure = {
    success: false,
    error: 'Invalid challenge or images',
    code: 'VOTE_FAILED',
    message: 'Unable to submit votes for this challenge',
};

/**
 * Mock vote images for different challenges
 */
const mockVoteImagesByChallenge = {
    'street-photography-2024': mockVoteImages,
    'portrait-photography-2024': {
        challenge: {
            id: 1002,
            title: 'Portrait Photography',
            url: 'portrait-photography-2024',
        },
        voting: {
            exposure: {
                exposure_factor: 100,
                max_exposure: 100,
            },
        },
        images: [],
    },
    'macro-photography-2024': {
        challenge: {
            id: 1004,
            title: 'Macro Photography',
            url: 'macro-photography-2024',
        },
        voting: {
            exposure: {
                exposure_factor: 45,
                max_exposure: 100,
            },
        },
        images: [
            {
                id: 'vote_img_101',
                image_url: 'https://example.com/macro1.jpg',
                photographer: 'Macro Master',
                title: 'Dew Drop',
                ratio: 4.2,
                votes: 15,
            },
            {
                id: 'vote_img_102',
                image_url: 'https://example.com/macro2.jpg',
                photographer: 'Close Up Pro',
                title: 'Flower Petals',
                ratio: 5.8,
                votes: 27,
            },
            {
                id: 'vote_img_103',
                image_url: 'https://example.com/macro3.jpg',
                photographer: 'Detail Hunter',
                title: 'Insect Eye',
                ratio: 6.5,
                votes: 33,
            },
        ],
    },
};

module.exports = {
    mockVoteImages,
    mockEmptyVoteImages,
    mockVoteSubmissionSuccess,
    mockVoteSubmissionFailure,
    mockVoteImagesByChallenge,
    generateMockVoteImages,
}; 