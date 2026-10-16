import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { openStore } from '../../dist/storage.js';

// Existing feature tests explicitly provision an owner/session in their isolated DB.
// Auth tests use the public setup/login endpoints instead. No application bypass exists.
const salt = randomBytes(16).toString('hex');
const password_hash = scryptSync(randomBytes(32), salt, 64).toString('hex');
const tokens = new Map();
export function authHeaders(dataDir) {
  const store = openStore(dataDir);
  try {
    store.auth.createOwner({ username: 'test-owner', salt, password_hash });
    let token = tokens.get(dataDir);
    if (!token) { token = randomBytes(32).toString('hex'); tokens.set(dataDir, token); }
    const hash = createHash('sha256').update(token).digest('hex');
    if (!store.auth.session(hash)) store.auth.addSession(hash, Date.now() + 43_200_000, store.auth.owner());
    return { cookie: `callmate_session=${token}` };
  } finally { store.close(); }
}
