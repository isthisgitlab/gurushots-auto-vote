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

[2025-12-09 16:56] - Updated by Junie
{
    "TYPE": "correction",
    "CATEGORY": "naming conventions",
    "ERROR": "Used 'boost' terminology instead of 'turbo'",
    "NEW INSTRUCTION": "WHEN referring to this feature in analysis or code changes THEN use the term 'turbo' consistently"
}

[2025-12-09 16:57] - Updated by Junie
{
    "TYPE": "correction",
    "CATEGORY": "feature distinction",
    "ERROR": "Conflated turbo with boost",
    "NEW INSTRUCTION": "WHEN user requests turbo logic THEN describe only turbo feature and exclude boost"
}

[2025-12-09 16:58] - Updated by Junie
{
    "TYPE": "correction",
    "CATEGORY": "feature distinction",
    "ERROR": "Focused on boost instead of turbo",
    "NEW INSTRUCTION": "WHEN asked about turbo logic THEN inspect and describe only turbo code, not boost"
}

