// Callable wrapper for the 'sendSlackTest' backend function.
import { functions } from '@/api/client';
export const sendSlackTest = (body = {}) => functions.invoke('sendSlackTest', body);
export default sendSlackTest;
