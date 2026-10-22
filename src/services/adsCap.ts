/**
 * Moved to src/services/ads/money.ts, THE money rule (tests: src/services/ads/money.test.ts). Re-exported here for one phase so older
 * imports keep working; new code imports from ads/money.ts.
 */
export {
    accountMonthEnd, CAMPAIGN_FIELDS, campaignBudget, campaignInsights, checkWorstCase, daysLeftThisMonth, isActive, lifetimeSpend,
    oneDayRemaining, readCampaigns, readMonth, readSpend, remainingThisMonth, shouldPauseAll,
    type CampaignBudget, type CapCheck, type MonthPicture, type RawBudgetHolder, type RawCampaign,
} from './ads/money.js';
