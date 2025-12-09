[2025-12-09 16:27] - Updated by Junie
{
    "TYPE": "correction",
    "CATEGORY": "auto-boost logic",
    "ERROR": "shouldApplyBoost ignores key-unlocked case",
    "NEW INSTRUCTION": "WHEN boost available and no timeout present THEN auto-apply only if challenge ends within 10 minutes"
}

[2025-12-09 16:28] - Updated by Junie
{
    "TYPE": "correction",
    "CATEGORY": "auto-boost logic",
    "ERROR": "shouldApplyBoost ignores key-unlocked case",
    "NEW INSTRUCTION": "WHEN boost available and no timeout present THEN auto-apply only if challenge ends within 10 minutes"
}

[2025-12-09 16:29] - Updated by Junie
{
    "TYPE": "new instructions",
    "CATEGORY": "tests",
    "ERROR": "-",
    "NEW INSTRUCTION": "WHEN creating or updating boost mocks THEN include key-unlocked no-timeout cases with end times before and after 10 minutes"
}

[2025-12-09 16:31] - Updated by Junie
{
    "TYPE": "correction",
    "CATEGORY": "mocks",
    "ERROR": "misclassified as tests instead of mocks",
    "NEW INSTRUCTION": "WHEN adding boost case scenarios THEN update mocks files, not test files"
}

[2025-12-09 16:35] - Updated by Junie
{
    "TYPE": "correction",
    "CATEGORY": "auto-boost logic",
    "ERROR": "Downstream logic after shouldApplyBoost may still use old rules",
    "NEW INSTRUCTION": "WHEN modifying shouldApplyBoost THEN update all subsequent auto-boost handling to honor the 10-minute end-time rule"
}

