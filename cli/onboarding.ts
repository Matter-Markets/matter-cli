import {createCipheriv, createDecipheriv, randomBytes, scryptSync} from 'node:crypto';
import {chmod, mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {getAddress, type Address, type Hex} from 'viem';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {z} from 'zod';
import {PlatformCredentialStore} from './runtime/credentials.js';

const nameSchema = z.string().regex(/^[a-z0-9-]{3,20}$/);
const responseSchema = z.object({
  id: z.string(),
  name: z.string(),
  agentKey: z.string(),
  claimUrl: z.string().url(),
  expiresAt: z.string(),
});

const onboardingStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  claimUrl: z.string().url(),
  state: z.string(),
  steps: z.object({
    claimed: z.boolean(),
    registered: z.boolean(),
    bounded: z.boolean(),
    funded: z.boolean(),
    runtimeProven: z.boolean(),
  }),
  boundaries: z.object({maxTradeUsdg: z.string()}).passthrough().nullable().optional(),
}).passthrough();

export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>;

interface AgentKeystore {
  version: 1;
  address: Address;
  crypto: {
    cipher: 'aes-256-gcm';
    ciphertext: string;
    iv: string;
    tag: string;
    kdf: 'scrypt';
    salt: string;
    n: number;
    r: number;
    p: number;
  };
}

export interface LocalOnboarding {
  id: string;
  api: string;
  name: string;
  agentKey: Address;
  claimUrl: string;
  expiresAt: string;
}

function requirePassphrase(): string {
  const passphrase = process.env.MATTER_KEY_PASSPHRASE;
  if (!passphrase || passphrase.length < 12) {
    throw new Error('MATTER_KEY_PASSPHRASE must contain at least 12 characters; load it from a secret manager');
  }
  return passphrase;
}

export function encryptAgentKey(privateKey: Hex, passphrase: string): AgentKeystore {
  if (passphrase.length < 12) throw new Error('keystore passphrase must contain at least 12 characters');
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const n = 16_384;
  const r = 8;
  const p = 1;
  const key = scryptSync(passphrase, salt, 32, {N: n, r, p});
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(privateKey.slice(2), 'hex')), cipher.final()]);
  return {
    version: 1,
    address: privateKeyToAccount(privateKey).address,
    crypto: {
      cipher: 'aes-256-gcm',
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      n,
      r,
      p,
    },
  };
}

export function decryptAgentKey(keystore: AgentKeystore, passphrase: string): Hex {
  if (keystore.version !== 1 || keystore.crypto.cipher !== 'aes-256-gcm' || keystore.crypto.kdf !== 'scrypt') {
    throw new Error('unsupported Matter keystore');
  }
  const salt = Buffer.from(keystore.crypto.salt, 'base64');
  const key = scryptSync(passphrase, salt, 32, {N: keystore.crypto.n, r: keystore.crypto.r, p: keystore.crypto.p});
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(keystore.crypto.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(keystore.crypto.tag, 'base64'));
  const privateKey = Buffer.concat([
    decipher.update(Buffer.from(keystore.crypto.ciphertext, 'base64')),
    decipher.final(),
  ]);
  if (privateKey.length !== 32) throw new Error('invalid decrypted agent key');
  const value = `0x${privateKey.toString('hex')}` as Hex;
  if (getAddress(privateKeyToAccount(value).address) !== getAddress(keystore.address)) {
    throw new Error('keystore address check failed');
  }
  return value;
}

async function post(api: string, route: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${api.replace(/\/$/, '')}${route}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof payload.message === 'string' ? payload.message : `Matter API returned HTTP ${response.status}`);
  }
  return payload;
}

async function get(api: string, route: string): Promise<unknown> {
  const response = await fetch(`${api.replace(/\/$/, '')}${route}`, {headers: {accept: 'application/json'}});
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.message === 'string' ? payload.message : `Matter API returned HTTP ${response.status}`);
  return payload;
}

export async function readLocalOnboarding(workspace: string): Promise<LocalOnboarding> {
  return JSON.parse(await readFile(path.join(workspace, '.matter', 'onboarding.json'), 'utf8')) as LocalOnboarding;
}

export async function onboardingStatus(workspace: string): Promise<OnboardingStatus> {
  const local = await readLocalOnboarding(workspace);
  return onboardingStatusSchema.parse(await get(local.api, `/onboarding/${local.id}`));
}

async function ensureEmptyWorkspace(root: string): Promise<void> {
  for (const filename of ['matter.toml', 'MATTER.md', path.join('.matter', 'agent-key.json')]) {
    try {
      await stat(path.join(root, filename));
      throw new Error(`refusing to overwrite existing Matter workspace file: ${filename}`);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
}

async function secureWrite(filename: string, content: string): Promise<void> {
  await writeFile(filename, content, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
  await chmod(filename, 0o600).catch(() => undefined);
}

export async function initializeAgent(options: {
  name: string;
  api: string;
  rpc?: string | undefined;
  workspace: string;
  metadataUri?: string | undefined;
}): Promise<LocalOnboarding> {
  const name = nameSchema.parse(options.name);
  const root = path.resolve(options.workspace);
  const api = options.api.replace(/\/$/, '');
  const passphrase = requirePassphrase();
  await mkdir(root, {recursive: true});
  await ensureEmptyWorkspace(root);

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const keystore = encryptAgentKey(privateKey, passphrase);
  const response = responseSchema.parse(await post(api, '/onboarding', {
    name,
    agentKey: account.address,
    metadataUri: options.metadataUri ?? '',
  }));
  const local: LocalOnboarding = {
    id: response.id,
    api,
    name: response.name,
    agentKey: getAddress(response.agentKey),
    claimUrl: response.claimUrl,
    expiresAt: response.expiresAt,
  };

  const privateDirectory = path.join(root, '.matter');
  await mkdir(privateDirectory, {recursive: true, mode: 0o700});
  await secureWrite(path.join(privateDirectory, 'agent-key.json'), JSON.stringify(keystore, null, 2) + '\n');
  await secureWrite(path.join(privateDirectory, 'onboarding.json'), JSON.stringify(local, null, 2) + '\n');
  await writeFile(path.join(root, 'matter.toml'), [
    '[agent]',
    `name = "${name}"`,
    '',
    '[network]',
    'chain_id = 4663',
    `api = "${api}"`,
    ...(options.rpc ? [`rpc = "${options.rpc.replace(/\/$/, '')}"`] : []),
    '',
  ].join('\n'), {encoding: 'utf8', flag: 'wx'});
  await writeFile(path.join(root, 'MATTER.md'), [
    `# ${name}`,
    '',
    'Describe the agent strategy, thesis, sources, and explicit conditions for standing down.',
    '',
    'The onchain boundary configuration is authoritative. This file cannot expand it.',
    '',
  ].join('\n'), {encoding: 'utf8', flag: 'wx'});
  return local;
}

export interface SignupHandoff extends LocalOnboarding {
  workspace: string;
  credentialReference: string;
  credentialStored: boolean;
  recoveryPassphrase: string;
}

export function formatOwnerHandoff(handoff: SignupHandoff): string {
  return [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'MATTER AGENT SIGNUP · OWNER HANDOFF',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `Agent             ${handoff.name}`,
    `Status            AWAITING OWNER CLAIM`,
    `Agent public key  ${handoff.agentKey}`,
    `Claim link        ${handoff.claimUrl}`,
    `Claim expires     ${handoff.expiresAt}`,
    '',
    'LOCAL CUSTODY',
    `Workspace         ${handoff.workspace}`,
    `Encrypted key     ${path.join(handoff.workspace, '.matter', 'agent-key.json')}`,
    `Credential ref    ${handoff.credentialReference}`,
    `OS vault          ${handoff.credentialStored ? 'stored for this user' : 'unavailable — save the recovery passphrase now'}`,
    '',
    'RECOVERY CREDENTIAL · SHOW ONCE · KEEP PRIVATE',
    handoff.recoveryPassphrase,
    '',
    'OWNER ACTION',
    '1. Open the claim link.',
    '2. Connect the wallet that will own the agent.',
    '3. Review and sign registration, boundaries, and funding.',
    '4. Return here and tell me the claim is complete.',
    '',
    'The private signing key was generated locally, is encrypted at rest,',
    'was never sent to Matter, and is intentionally not printed here.',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');
}

export async function signupAgent(options: {
  name: string;
  api: string;
  rpc?: string | undefined;
  workspace: string;
  metadataUri?: string | undefined;
}): Promise<SignupHandoff> {
  const recoveryPassphrase = randomBytes(32).toString('base64url');
  const credentialReference = `matter/agent/${options.name}/keystore-passphrase`;
  const credentials = new PlatformCredentialStore();
  let credentialStored = false;
  const previousPassphrase = process.env.MATTER_KEY_PASSPHRASE;
  process.env.MATTER_KEY_PASSPHRASE = recoveryPassphrase;
  try {
    try {
      await credentials.put(credentialReference, recoveryPassphrase);
      credentialStored = true;
    } catch {
      credentialStored = false;
    }
    const created = await initializeAgent(options);
    return {
      ...created,
      workspace: path.resolve(options.workspace),
      credentialReference,
      credentialStored,
      recoveryPassphrase,
    };
  } catch (error) {
    if (credentialStored) await credentials.delete(credentialReference).catch(() => undefined);
    throw error;
  } finally {
    if (previousPassphrase === undefined) delete process.env.MATTER_KEY_PASSPHRASE;
    else process.env.MATTER_KEY_PASSPHRASE = previousPassphrase;
  }
}

export async function activateAgent(workspace: string): Promise<{expiresAt: string; state: string}> {
  const root = path.resolve(workspace);
  const privateDirectory = path.join(root, '.matter');
  const [localRaw, keystoreRaw] = await Promise.all([
    readFile(path.join(privateDirectory, 'onboarding.json'), 'utf8'),
    readFile(path.join(privateDirectory, 'agent-key.json'), 'utf8'),
  ]);
  const local = JSON.parse(localRaw) as LocalOnboarding;
  const keystore = JSON.parse(keystoreRaw) as AgentKeystore;
  const account = privateKeyToAccount(decryptAgentKey(keystore, requirePassphrase()));
  if (getAddress(account.address) !== getAddress(local.agentKey)) throw new Error('local onboarding and keystore agent keys disagree');

  const challenge = await post(local.api, `/onboarding/${local.id}/runtime/challenge`, {}) as {challengeId: Hex; message: string};
  const signature = await account.signMessage({message: challenge.message});
  const proof = await post(local.api, `/onboarding/${local.id}/runtime/prove`, {
    challengeId: challenge.challengeId,
    signature,
  }) as {token: string; expiresAt: string; status: {state: string}};
  await secureWrite(path.join(privateDirectory, `session-${Date.now()}.json`), JSON.stringify({
    token: proof.token,
    expiresAt: proof.expiresAt,
    api: local.api,
    onboardingId: local.id,
  }, null, 2) + '\n');
  return {expiresAt: proof.expiresAt, state: proof.status.state};
}
