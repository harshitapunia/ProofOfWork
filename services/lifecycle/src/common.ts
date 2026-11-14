import { PublicKey } from "@solana/web3.js";
export class LifecycleError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export function check(ok: unknown, code = "invalid_input"): asserts ok {
  if (!ok) throw new LifecycleError(code);
}
export const MAX_ID = 0xffffffffffffffffn;
export function u64(value: unknown): bigint {
  check(typeof value === "bigint" && value >= 0n && value <= MAX_ID); return value;
}
export function address(value: unknown, nonzero = true): string {
  try {
    check(typeof value === "string" && value.length >= 32 && value.length <= 44);
    const key = new PublicKey(value);
    check(key.toBase58() === value && (!nonzero || !key.equals(PublicKey.default))); return value;
  } catch { throw new LifecycleError("invalid_input"); }
}
export function exact(value: unknown, fields: readonly string[]): void {
  try {
    check(value !== null && typeof value === "object" && !Array.isArray(value));
    check(Reflect.ownKeys(value).length === fields.length && fields.every(k => {
      const d = Object.getOwnPropertyDescriptor(value, k);
      return d?.enumerable === true && Object.hasOwn(d, "value");
    }));
  } catch { throw new LifecycleError("invalid_input"); }
}
