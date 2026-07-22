import {randomBytes} from 'node:crypto';
import {PlatformCredentialStore} from './credentials.js';
import type {CredentialStore} from './types.js';

export const DAEMON_CREDENTIAL_REFERENCE = 'matter/system/daemon/v1';

export async function daemonToken(credentials: CredentialStore = new PlatformCredentialStore()): Promise<string> {
  let token = await credentials.get(DAEMON_CREDENTIAL_REFERENCE);
  if (!token) {
    token = randomBytes(32).toString('base64url');
    await credentials.put(DAEMON_CREDENTIAL_REFERENCE, token);
  }
  if (Buffer.from(token, 'base64url').length !== 32) throw new Error('invalid Matter daemon authentication token');
  return token;
}
