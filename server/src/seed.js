import 'dotenv/config';
import crypto from 'node:crypto';
import { getUserByUsername, createUser } from './db.js';
import { hashPassword } from './auth.js';

const username = process.env.SUPERADMIN_USERNAME || 'admin';
const password = process.env.SUPERADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');

const existing = getUserByUsername(username);
if (existing) {
  console.log(`Super admin "${username}" already exists (id=${existing.id}). Nothing to do.`);
  process.exit(0);
}

const passwordHash = await hashPassword(password);
const user = createUser({ username, passwordHash, role: 'SUPER_ADMIN' });

console.log('Super admin created:');
console.log(`  username: ${user.username}`);
console.log(`  password: ${password}`);
console.log('Store this password now — it will not be shown again. Change it after first login.');
