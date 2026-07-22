// Callable wrapper for the 'backfillLeadType' backend function.
import { functions } from '@/api/client';
export const backfillLeadType = (body = {}) => functions.invoke('backfillLeadType', body);
export default backfillLeadType;
