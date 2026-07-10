// Callable wrapper for the 'submitBuyerOnboarding' backend function.
import { functions } from '@/api/client';
export const submitBuyerOnboarding = (body = {}) => functions.invoke('submitBuyerOnboarding', body);
export default submitBuyerOnboarding;
