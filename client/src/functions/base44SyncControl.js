import { functions } from '@/api/client';

export const base44SyncControl = (body = {}) => functions.invoke('base44SyncControl', body);
export default base44SyncControl;
