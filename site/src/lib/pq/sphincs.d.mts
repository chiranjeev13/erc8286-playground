export const SIG_LEN: number;
export type SphincsKey = { pkSeed: `0x${string}`; pkRoot: `0x${string}` };
export function hexToBytes(hex: string): Uint8Array;
export function bytesToHex(bytes: Uint8Array): `0x${string}`;
export function keyFromSeeds(skSeed: Uint8Array, skPrf: Uint8Array, pkSeed: Uint8Array): SphincsKey;
export function keyFromSecret(secret: Uint8Array): SphincsKey;
export function randomSecret(): Uint8Array;
export function sign(key: SphincsKey, messageHex: string): `0x${string}`;
