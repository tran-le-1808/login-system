// auth/helpers/bcrypt.helper.ts
import bcrypt from 'bcrypt';

const SALT = 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT);
}

export async function comparePasswords(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
