const CREDENTIAL_PATTERNS = [
  /\bsk-[a-zA-Z0-9_-]{16,}\b/g,
  /\bsk-ant-[a-zA-Z0-9_-]{16,}\b/g,
  /\bAIza[a-zA-Z0-9_-]{20,}\b/g,
  /\b(?:gsk_|xai-|or-)[a-zA-Z0-9_-]{16,}\b/g,
  /\bmatter_rt_[a-zA-Z0-9_-]{16,}\b/g,
  /\b0x[a-fA-F0-9]{64}\b/g,
];

export class SecretRedactor {
  readonly #secrets = new Set<string>();

  constructor(secrets: Array<string | null | undefined> = []) {
    for (const secret of secrets) if (secret && secret.length >= 8) this.#secrets.add(secret);
  }

  add(secret: string | null | undefined): void { if (secret && secret.length >= 8) this.#secrets.add(secret); }

  text(value: string): string {
    let output = value;
    for (const secret of this.#secrets) output = output.split(secret).join('[REDACTED]');
    for (const pattern of CREDENTIAL_PATTERNS) output = output.replace(pattern, '[REDACTED]');
    return output;
  }

  value<T>(value: T): T {
    if (typeof value === 'string') return this.text(value) as T;
    if (Array.isArray(value)) return value.map(item => this.value(item)) as T;
    if (value && typeof value === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) output[key] = /key|secret|token|authorization|rawtransaction/i.test(key) ? '[REDACTED]' : this.value(item);
      return output as T;
    }
    return value;
  }
}
