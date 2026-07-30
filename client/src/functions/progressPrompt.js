// Callable wrapper for the 'progressPrompt' backend function.
import { functions } from '@/api/client';
export const progressPrompt = (body = {}) => functions.invoke('progressPrompt', body);
export default progressPrompt;
