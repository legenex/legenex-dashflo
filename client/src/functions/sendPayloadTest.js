// Callable wrapper for the 'sendPayloadTest' backend function.
import { functions } from '@/api/client';
export const sendPayloadTest = (body = {}) => functions.invoke('sendPayloadTest', body);
export default sendPayloadTest;
