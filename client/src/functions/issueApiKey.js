// Callable wrapper for the 'issueApiKey' backend function.
import { functions } from '@/api/client';
export const issueApiKey = (body = {}) => functions.invoke('issueApiKey', body);
export default issueApiKey;
