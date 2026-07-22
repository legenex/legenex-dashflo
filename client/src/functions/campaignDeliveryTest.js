// Callable wrapper for the 'campaignDeliveryTest' backend function.
import { functions } from '@/api/client';
export const campaignDeliveryTest = (body = {}) => functions.invoke('campaignDeliveryTest', body);
export default campaignDeliveryTest;
