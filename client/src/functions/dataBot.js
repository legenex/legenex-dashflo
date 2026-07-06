// Callable wrapper for the 'dataBot' backend function.
import { functions } from '@/api/client';
export const dataBot = (body = {}) => functions.invoke('dataBot', body);
export default dataBot;
