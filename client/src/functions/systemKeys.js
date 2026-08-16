import { functions } from '@/api/client';

export const systemKeys = (body = {}) => functions.invoke('systemKeys', body);
export default systemKeys;
