import React, { useEffect } from 'react';
import { usePermissions } from '@/lib/AuthContext';
import PageNotFound from '@/lib/PageNotFound';
import { progressHostUrl } from '@/lib/hostScope';

/* What /progress and everything under it now answers on the application host.
 *
 * The Progress Control Center is internal owner tooling and lives on its own
 * hostname. It is not rendered here any more, by anyone, so there is exactly one
 * copy of it and one place where access to it is decided.
 *
 * Two behaviours, and the difference between them matters:
 *
 *   Owner: sent to the Control Center on its own host. Old bookmarks and links
 *   keep working, and the deep path is carried across so /progress/findings
 *   lands on findings rather than on the dashboard. /progress is not the
 *   namespace over there: the Control Center is the whole of that host, so
 *   /progress becomes its root and /progress/findings becomes /findings.
 *
 *   Everyone else: the ordinary not-found page. Not "access denied", not
 *   "moved to progress.dashflo.io", because either of those confirms the tool
 *   exists and tells the reader where to go looking for it. To an account that
 *   is not the owner, this path simply is not a page.
 *
 * Anonymous visitors never reach this component: it renders inside
 * ProtectedRoute, which sends them to log in first. After signing in they land
 * back here and are then sorted by the same rule.
 *
 * None of this is the security boundary. The server refuses Progress entities
 * and Progress functions to non-owners regardless of what the browser renders,
 * which is what makes typing the URL, or calling the API directly, pointless.
 */
export default function ProgressRelocated() {
  const { realRole } = usePermissions();
  const isOwner = realRole === 'owner';

  useEffect(() => {
    if (!isOwner) return;
    // Carry the path across, but only the path this app served. Building the
    // destination from location.pathname rather than from anything a query
    // string supplied keeps this a fixed redirect to one known origin, and
    // mapping it means a path the Control Center does not serve lands on its
    // Command Center instead of on a dead URL.
    const { pathname, search, hash } = window.location;
    window.location.replace(progressHostUrl(pathname, search, hash));
  }, [isOwner]);

  if (!isOwner) return <PageNotFound />;

  return (
    <div className="flex-1 flex items-center justify-center py-24">
      <div className="text-center">
        <p className="text-[15px] font-semibold text-foreground">Opening the Control Center</p>
        <p className="text-[13px] text-muted-foreground mt-1">
          Progress moved to its own address.
        </p>
      </div>
    </div>
  );
}
