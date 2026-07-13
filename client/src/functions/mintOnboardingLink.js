// Callable wrapper for the 'mintOnboardingLink' backend function.
import { functions } from '@/api/client';
export const mintOnboardingLink = (body = {}) => functions.invoke('mintOnboardingLink', body);
export default mintOnboardingLink;
