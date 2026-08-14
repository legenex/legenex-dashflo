// Callable wrapper for the 'pullCallLogs' backend function.
import { functions } from '@/api/client';
export const pullCallLogs = (body = {}) => functions.invoke('pullCallLogs', body);
export default pullCallLogs;
