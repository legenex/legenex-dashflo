import readline from 'node:readline';

export function generateTimestampedFilename(prefix, extension) {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `${prefix}-${stamp}.${extension}`;
}

export function createReadlineInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
}

export function question(rl, query) {
  return new Promise((resolve) => {
    rl.question(query, (answer) => resolve(answer));
  });
}

/**
 * Read a hidden passphrase from TTY with no echo.
 * Returns the passphrase string (without trailing newline).
 * Throws on Ctrl+C or terminal errors.
 */
export async function readHiddenPassphrase(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    if (!stdin.isTTY) {
      reject(new Error('Not a TTY'));
      return;
    }

    const hadRawMode = stdin.isRaw;
    let input = '';
    let closed = false;

    function cleanup() {
      if (closed) return;
      closed = true;
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdin.removeListener('error', onError);
      process.removeListener('SIGINT', onSigint);
    }

    function onData(chunk) {
      const char = chunk.toString('utf8');
      for (const c of char) {
        const code = c.charCodeAt(0);
        if (code === 3) { // Ctrl+C
          stdout.write('\n');
          cleanup();
          reject(new Error('Cancelled'));
          return;
        }
        if (code === 13 || code === 10) { // Enter
          stdout.write('\n');
          cleanup();
          resolve(input);
          return;
        }
        if (code === 127 || code === 8) { // Backspace/Delete
          if (input.length > 0) {
            input = input.slice(0, -1);
            stdout.write('\b \b');
          }
          return;
        }
        if (code >= 32 && code <= 126) { // Printable ASCII
          input += c;
          stdout.write('*');
        }
      }
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    function onSigint() {
      stdout.write('\n');
      cleanup();
      reject(new Error('Cancelled'));
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdin.on('error', onError);
    process.on('SIGINT', onSigint);

    stdout.write(prompt);
  });
}

export async function readHiddenPassphraseWithConfirmation(prompt, confirmPrompt, minLength) {
  while (true) {
    const passphrase = await readHiddenPassphrase(prompt);
    if (!passphrase) {
      throw new Error('Passphrase cannot be empty');
    }
    if (passphrase.length < minLength) {
      throw new Error(`Passphrase must be at least ${minLength} characters`);
    }
    const confirm = await readHiddenPassphrase(confirmPrompt);
    if (passphrase !== confirm) {
      throw new Error('Passphrases do not match');
    }
    return passphrase;
  }
}

export async function readPassphraseFromStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
    process.stdin.resume();
  });
}