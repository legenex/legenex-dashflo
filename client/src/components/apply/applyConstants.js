// Public onboarding constants. Kept separate from operator-side helpers so the
// /apply flow stays fully decoupled from the authenticated shell.

// Canonical production URL for the public application form. Defined once here so
// the shared link is correct even inside the editor/preview (where the runtime
// origin is a preview host). Update this single place if the domain changes.
export const PUBLIC_APPLICATION_URL = 'https://dashboard.legenex.com/apply';

// Fifty states plus DC, matching the server side allow list in
// submitBuyerOnboarding. Two letter codes, uppercase, alphabetical.
export const APPLY_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];

export const CLIENT_TYPES = ['Law Firm', 'Aggregator', 'Reseller', 'Network'];

export const BILLING_TYPES = [
  { value: 'prepay', label: 'Prepay deposit' },
  { value: 'invoiced_daily', label: 'Invoiced daily' },
  { value: 'invoiced_weekly', label: 'Invoiced weekly' },
  { value: 'invoiced_monthly', label: 'Invoiced monthly' },
];

// The three steps of the flow, in order.
export const STEPS = [
  { key: 'company', label: 'Company' },
  { key: 'commercial', label: 'Coverage & terms' },
  { key: 'details', label: 'Additional detail' },
];