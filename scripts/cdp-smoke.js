// Authenticated smoke test via Chrome DevTools Protocol (Node 22 global WebSocket).
// Injects the JWT into localStorage, loads the app, and reports console errors +
// visible text so we can confirm the authenticated dashboard actually renders.
const BASE = 'http://localhost:4000';
const TOKEN = process.env.TOKEN;

async function main() {
  const targets = await (await fetch('http://localhost:9222/json')).json();
  let page = targets.find((t) => t.type === 'page');
  // Create a fresh tab if needed.
  if (!page) page = await (await fetch('http://localhost:9222/json/new')).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push('console.error: ' + msg.params.args.map((a) => a.value || a.description || '').join(' '));
    }
  };
  const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });

  await send('Runtime.enable');
  await send('Page.enable');
  // Seed the token on the app origin, then navigate.
  await send('Page.navigate', { url: `${BASE}/login` });
  await new Promise((r) => setTimeout(r, 1500));
  await send('Runtime.evaluate', { expression: `localStorage.setItem('dashos_access_token', ${JSON.stringify(TOKEN)})` });
  await send('Page.navigate', { url: `${BASE}/` });
  await new Promise((r) => setTimeout(r, 6000));

  const textRes = await send('Runtime.evaluate', {
    expression: `(document.querySelector('#root')?.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 600)`,
    returnByValue: true,
  });
  const urlRes = await send('Runtime.evaluate', { expression: 'location.pathname', returnByValue: true });

  console.log('=== final path:', urlRes.result.value);
  console.log('=== authenticated #root text ===');
  console.log(textRes.result.value || '(empty)');
  console.log('=== JS errors (' + errors.length + ') ===');
  errors.slice(0, 10).forEach((e) => console.log(' -', e));
  ws.close();
}

main().catch((e) => { console.error('smoke error:', e.message); process.exit(1); });
