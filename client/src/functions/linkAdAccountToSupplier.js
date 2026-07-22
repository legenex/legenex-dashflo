// Callable wrapper for the 'linkAdAccountToSupplier' backend function.
import { functions } from '@/api/client';
export const linkAdAccountToSupplier = (body = {}) => functions.invoke('linkAdAccountToSupplier', body);
export default linkAdAccountToSupplier;
