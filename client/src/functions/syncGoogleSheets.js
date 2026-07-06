// Callable wrapper for the 'syncGoogleSheets' backend function.
import { functions } from '@/api/client';
export const syncGoogleSheets = (body = {}) => functions.invoke('syncGoogleSheets', body);
export default syncGoogleSheets;
