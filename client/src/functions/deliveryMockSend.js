// Callable wrapper for the 'deliveryMockSend' backend function.
import { functions } from '@/api/client';
export const deliveryMockSend = (body = {}) => functions.invoke('deliveryMockSend', body);
export default deliveryMockSend;
