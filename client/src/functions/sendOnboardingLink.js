// Callable wrapper for the 'sendOnboardingLink' backend function.
import { functions } from '@/api/client';
export const sendOnboardingLink = (body = {}) => functions.invoke('sendOnboardingLink', body);
export default sendOnboardingLink;
