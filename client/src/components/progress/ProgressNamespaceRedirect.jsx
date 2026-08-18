import { Navigate, useLocation } from 'react-router-dom';
import { canonicalProgressPath, PROGRESS_ROOT_PATH } from '@/lib/hostScope';

/* What /progress and everything under it answers on the Control Center host.
 *
 * The Control Center is this host. Its address is progress.dashflo.io/, so
 * /progress is a path from the era when it was a section of the operator app
 * and is not the canonical namespace any more. Old bookmarks, old links and the
 * capture queue's return path all still arrive here, and each one is mapped
 * onto the canonical path rather than being served under the old name.
 *
 *   /progress            becomes /
 *   /progress/findings   becomes /findings
 *   /progress/anything   the host does not serve becomes /
 *
 * The redirect renders inside the route table rather than in place of it. That
 * is the whole point: a redirect returned instead of <Routes> changes the URL
 * and then never re-renders, which is what left this host showing an empty page
 * on its own root. Everything that redirects on this host is a route.
 *
 * The mapped path can never equal the path that arrived, because everything
 * routed here starts with /progress and nothing this host serves does, so this
 * cannot bounce between two paths.
 */
export default function ProgressNamespaceRedirect() {
  const location = useLocation();
  const to = canonicalProgressPath(location.pathname);
  const target = to === location.pathname ? PROGRESS_ROOT_PATH : to;
  return <Navigate to={`${target}${location.search}${location.hash}`} replace />;
}
