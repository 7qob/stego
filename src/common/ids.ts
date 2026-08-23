import { randomBytes } from 'node:crypto';

// Unambiguous alphabet — no 0/O or 1/l/I, so IDs survive being read aloud
// or retyped from a screenshot.
const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz';

function randomString(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/** Public, guessable-resistant file identifier. ~50 bits at length 10. */
export function generateFileId(): string {
  return randomString(10);
}

/** Secret handed to the uploader so they can delete their own file later. */
export function generateDeleteToken(): string {
  return randomBytes(24).toString('base64url');
}
