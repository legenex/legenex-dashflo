// Callable wrapper for the 'testHlr' backend function.
import { functions } from '@/api/client';
export const testHlr = (body = {}) => functions.invoke('testHlr', body);
export default testHlr;
