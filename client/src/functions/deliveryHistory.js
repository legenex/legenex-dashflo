// Callable wrapper for the 'deliveryHistory' backend function.
import { functions } from '@/api/client';
export const deliveryHistory = (body = {}) => functions.invoke('deliveryHistory', body);
export default deliveryHistory;
