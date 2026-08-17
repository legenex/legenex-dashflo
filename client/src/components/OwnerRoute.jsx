import { Outlet } from 'react-router-dom';
import { usePermissions } from '@/lib/AuthContext';

/* Owner-only route guard for the Progress Control Center host.
 *
 * This renders in place of the protected tree rather than around it. An account
 * that is not the owner never mounts ProgressLayout, so nothing under it runs:
 * no readiness query, no findings list, no screenshot, no internal note. The
 * refusal is the whole page, not a banner over a page that already loaded.
 *
 * realRole is used rather than role. Role can be a preview: owner and admin
 * accounts can view the app as another role, and that preview must not be able
 * to grant standing it does not have. Reading the real role means a previewing
 * owner keeps access and nothing else gains it.
 *
 * The message says nothing about what would have been required or what lives
 * here. Someone who reaches this screen is by definition not supposed to know.
 */
export default function OwnerRoute() {
  const { realRole } = usePermissions();

  if (realRole !== 'owner') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-6">
        <div className="text-center max-w-sm">
          <p className="text-[15px] font-semibold text-foreground">Access denied</p>
          <p className="text-[13px] text-muted-foreground mt-1">
            This account does not have access to this system.
          </p>
        </div>
      </div>
    );
  }

  return <Outlet />;
}
