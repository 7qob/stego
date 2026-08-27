#!/usr/bin/env node
/**
 * Prints a scrypt hash for STEGO_ADMIN_PASSWORD_HASH.
 *
 *   npm run admin:hash
 *
 * Reads from a TTY without echoing so the password does not land in shell
 * history, and takes stdin when piped so it can be scripted. The hash is
 * what belongs in .env — a plaintext STEGO_ADMIN_PASSWORD works, but it sits
 * readable in the environment of every process that can see /proc.
 */
const { randomBytes, scryptSync } = require('node:crypto');
const readline = require('node:readline');

function emit(password) {
  if (!password) {
    console.error('Empty password. Nothing written.');
    process.exit(1);
  }

  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  const value = `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;

  console.log('');
  console.log('Put this in .env:');
  console.log('');
  console.log(`STEGO_ADMIN_PASSWORD_HASH=${value}`);
  console.log('');
}

if (!process.stdin.isTTY) {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => emit(input.trim()));
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  // Suppress the echo so a shoulder-surfer and a scrollback buffer both miss it.
  const output = rl.output;
  rl.query = 'Admin password: ';
  output.write(rl.query);
  rl.output = { write: () => {} };

  rl.question('', (answer) => {
    rl.output = output;
    output.write('\n');
    rl.close();
    emit(answer.trim());
  });
}
