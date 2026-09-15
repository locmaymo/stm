import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

export const MIN_PASSWORD_LENGTH = 6;

export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string') {
    return 'Password is required';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > 256) {
    return 'Password is too long';
  }
  return null;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const derived = scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: 32 * 1024 * 1024,
  });
  return [
    'scrypt',
    SCRYPT_COST.toString(10),
    SCRYPT_BLOCK_SIZE.toString(10),
    SCRYPT_PARALLELIZATION.toString(10),
    salt.toString('base64url'),
    Buffer.from(derived).toString('base64url'),
  ].join('$');
}

export function verifyPassword(password: string, encoded: string): boolean {
  try {
    const [algorithm, costText, blockText, parallelText, saltText, keyText] = encoded.split('$');
    if (algorithm !== 'scrypt' || !costText || !blockText || !parallelText || !saltText || !keyText) {
      return false;
    }
    const cost = Number(costText);
    const blockSize = Number(blockText);
    const parallelization = Number(parallelText);
    if (
      ![cost, blockSize, parallelization].every(Number.isSafeInteger)
      || cost < 2 ** 14
      || cost > 2 ** 20
      || blockSize < 1
      || blockSize > 64
      || parallelization < 1
      || parallelization > 16
    ) {
      return false;
    }
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(keyText, 'base64url');
    if (salt.length < 8 || expected.length !== KEY_LENGTH) {
      return false;
    }
    const actual = scryptSync(password, salt, expected.length, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: 32 * 1024 * 1024,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Exactly six digits, which is what the public sign-in page can enter. */
export const PASSCODE_LENGTH = 6;

export function validatePasscode(value: unknown): string | null {
  if (typeof value !== 'string') return 'Passcode is required';
  if (!new RegExp(`^[0-9]{${PASSCODE_LENGTH}}$`, 'u').test(value)) return `The passcode must be ${PASSCODE_LENGTH} digits`;
  return null;
}
