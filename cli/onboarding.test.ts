import {describe, expect, it} from 'vitest';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {decryptAgentKey, encryptAgentKey} from './onboarding.js';

describe('agent keystore', () => {
  it('round-trips a local key and rejects the wrong passphrase', () => {
    const privateKey = generatePrivateKey();
    const keystore = encryptAgentKey(privateKey, 'correct horse battery staple');
    expect(keystore.address).toBe(privateKeyToAccount(privateKey).address);
    expect(decryptAgentKey(keystore, 'correct horse battery staple')).toBe(privateKey);
    expect(() => decryptAgentKey(keystore, 'incorrect passphrase')).toThrow();
  });

  it('requires a meaningful passphrase', () => {
    expect(() => encryptAgentKey(generatePrivateKey(), 'short')).toThrow('at least 12');
  });
});
