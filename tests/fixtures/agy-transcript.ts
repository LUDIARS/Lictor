import type { AgyRow } from "../../src/agy-steps.js";

function varint(input: number): Buffer {
  let value = BigInt(input);
  const bytes: number[] = [];
  do {
    bytes.push(Number(value & 127n) | (value >= 128n ? 128 : 0));
    value >>= 7n;
  } while (value);
  return Buffer.from(bytes);
}

function integer(field: number, value: number): Buffer {
  return Buffer.concat([varint(field * 8), varint(value)]);
}

export function bytes(field: number, value: Buffer | string): Buffer {
  const encoded = Buffer.from(value);
  return Buffer.concat([varint(field * 8 + 2), varint(encoded.length), encoded]);
}

export function prompt(idx: number, text: string, time: number): AgyRow {
  const metadata = bytes(1, Buffer.concat([
    integer(1, Math.floor(time / 1000)),
    integer(2, (time % 1000) * 1e6),
  ]));
  return {
    idx, step_type: 14, status: 3, step_format: 0, metadata,
    step_payload: Buffer.concat([integer(1, 14), bytes(19, bytes(2, text))]),
  };
}

export function answer(idx: number, fields: { response?: string; rendered?: string; tool?: boolean } = {}): AgyRow {
  const response = Buffer.concat([
    bytes(3, "private reasoning"),
    bytes(6, "bot-11111111-1111-4111-8111-111111111111"),
    ...(fields.response === undefined ? [] : [bytes(1, fields.response)]),
    ...(fields.rendered === undefined ? [] : [bytes(8, fields.rendered)]),
    ...(fields.tool ? [bytes(7, bytes(2, "run_command"))] : []),
  ]);
  return {
    idx, step_type: 15, status: 3, step_format: 0, metadata: null,
    step_payload: Buffer.concat([integer(1, 15), bytes(20, response)]),
  };
}

export function tool(idx: number, status: number): AgyRow {
  return {
    idx, step_type: 132, status, step_format: 0,
    metadata: bytes(4, Buffer.concat([
      bytes(1, "tool-call-1"), bytes(2, "run_command"), bytes(3, '{"private":"args"}'),
    ])),
    step_payload: null,
  };
}
