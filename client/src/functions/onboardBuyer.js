// Callable wrapper for the 'onboardBuyer' backend function.
import { functions } from '@/api/client';
export const onboardBuyer = (body = {}) => functions.invoke('onboardBuyer', body);
export default onboardBuyer;
