// Callable wrapper for the 'metaCampaignMappings' backend function.
import { functions } from '@/api/client';
export const metaCampaignMappings = (body = {}) => functions.invoke('metaCampaignMappings', body);
export default metaCampaignMappings;
