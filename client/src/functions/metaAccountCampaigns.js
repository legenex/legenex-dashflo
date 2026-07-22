// Callable wrapper for the 'metaAccountCampaigns' backend function.
import { functions } from '@/api/client';
export const metaAccountCampaigns = (body = {}) => functions.invoke('metaAccountCampaigns', body);
export default metaAccountCampaigns;
