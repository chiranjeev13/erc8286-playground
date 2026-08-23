import type { Hex } from "viem";

/**
 * The SENDER-frame shapes an account can authorize, as the ERC-7579-layout mode words
 * themselves: callType in byte 0, execType in byte 1, every remaining byte zero.
 *
 * These are policy declarations rather than capabilities -- the protocol performs batching
 * and atomicity with no account code, so any account *could* honour all four.
 */
export const FRAME_MODES = {
  single: `0x0201${"00".repeat(30)}`,
  "single-atomic": `0x0200${"00".repeat(30)}`,
  batch: `0x0301${"00".repeat(30)}`,
  "batch-atomic": `0x0300${"00".repeat(30)}`,
} as const satisfies Record<string, Hex>;

export type FrameModeName = keyof typeof FRAME_MODES;

/**
 * The APPROVE scopes accounts are deployed with: 0x1 payment, 0x2 execution, 0x3 both.
 *
 * Dropping 0x2 is a one-way door -- setApprovalScopes is reachable only through a SENDER
 * frame, which needs an execution approval.
 */
export const APPROVAL_SCOPES = 0x3;

/** The SENDER-frame shapes accounts are deployed willing to authorize. */
export const EXECUTION_MODE_NAMES: FrameModeName[] = [
  "single",
  "single-atomic",
  "batch",
  "batch-atomic",
];

export const EXECUTION_MODES: Hex[] = EXECUTION_MODE_NAMES.map((n) => FRAME_MODES[n]);
