// Callable wrapper for the 'mapMetaCampaigns' backend function.
import { functions } from '@/api/client';
export const mapMetaCampaigns = (body = {}) => functions.invoke('mapMetaCampaigns', body);
export default mapMetaCampaigns;
