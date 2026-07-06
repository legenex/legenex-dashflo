// Callable wrapper for the 'walkthroughGuide' backend function.
import { functions } from '@/api/client';
export const walkthroughGuide = (body = {}) => functions.invoke('walkthroughGuide', body);
export default walkthroughGuide;
