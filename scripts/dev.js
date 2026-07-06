// Run the API server and the Vite dev server together for local development.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function run(name, cwd, cmd, args, color) {
  const child = spawn(cmd, args, { cwd: path.join(root, cwd), shell: true, env: process.env });
  const tag = `\x1b[${color}m[${name}]\x1b[0m`;
  child.stdout.on('data', (d) => process.stdout.write(`${tag} ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`${tag} ${d}`));
  child.on('exit', (code) => { console.log(`${tag} exited (${code})`); process.exit(code ?? 0); });
  return child;
}

run('server', 'server', 'npm', ['run', 'dev'], '36');
run('client', 'client', 'npm', ['run', 'dev'], '35');

process.on('SIGINT', () => process.exit(0));
