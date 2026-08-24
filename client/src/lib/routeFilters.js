// Pure parse helper for RouteMember.filters. Split out from
// RouteFiltersPanel.jsx so this can be unit tested without a DOM environment.
export function parseFilters(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
