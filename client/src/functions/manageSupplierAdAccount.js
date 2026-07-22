// Callable wrapper for the 'manageSupplierAdAccount' backend function.
import { functions } from '@/api/client';
export const manageSupplierAdAccount = (body = {}) => functions.invoke('manageSupplierAdAccount', body);
export default manageSupplierAdAccount;
