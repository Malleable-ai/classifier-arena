/**
 * Integer-only hashing helpers shared by every game and the classifier core. Pure: the same input
 * gives the same output in Node and every browser.
 */

/** FNV-1a 64 over bytes, computed with two u32 halves. Returns 16 lowercase hex chars. */
export function fnv1a64(bytes: readonly number[]): string {
  // Offset basis 0xcbf29ce484222325; prime 0x100000001b3 = 2^40 + 0x1b3.
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (const byte of bytes) {
    lo = (lo ^ (byte & 0xff)) >>> 0;
    // (hi*2^32 + lo) * (2^40 + 0x1b3) mod 2^64
    const loProduct = lo * 0x1b3; // < 2^41, exact in a double
    const carry = Math.floor(loProduct / 0x100000000);
    const newLo = loProduct >>> 0;
    hi = (Math.imul(hi, 0x1b3) + carry + (lo << 8)) >>> 0;
    lo = newLo;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/**
 * JSON with object keys sorted (by UTF-16 code unit) at every level and no whitespace. Array
 * order is kept. Meant for plain JSON values (strings, finite numbers, booleans, null, arrays,
 * plain objects).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The UTF-8 encoding of `s`, as a plain byte array (input for `fnv1a64`). */
export function utf8Bytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}
