// Callable wrapper for the 'getOnboardingContext' backend function.
import { functions } from '@/api/client';
export const getOnboardingContext = (body = {}) => functions.invoke('getOnboardingContext', body);
export default getOnboardingContext;
