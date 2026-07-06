// Health check — used by the ApiStatus page.
export default async function health() {
  return { status: 'ok' };
}
