// Callable wrapper for the 'overviewBriefing' backend function.
import { functions } from '@/api/client';
export const overviewBriefing = (body = {}) => functions.invoke('overviewBriefing', body);
export default overviewBriefing;
