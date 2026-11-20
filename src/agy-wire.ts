import { TextDecoder } from "node:util";

type WireValue = bigint | Uint8Array;
type Fields = Map<number, WireValue[]>;

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

/** Protobuf only defines the wire type for these fields, so callers choose the known paths. */
export function readAgyWire(bytes: Uint8Array | null): Fields | null {
  if (!bytes || bytes.length > MAX_MESSAGE_BYTES) return null;
  const fields: Fields = new Map();
  let offset = 0;
  const varint = (): bigint => {
    let value = 0n;
    for (let index = 0; index < 10 && offset < bytes.length; index++) {
      const byte = bytes[offset++];
      if (index === 9 && byte > 1) throw new Error("varint overflow");
      value |= BigInt(byte & 0x7f) << BigInt(index * 7);
      if (byte < 0x80) return value;
    }
    throw new Error("unterminated varint");
  };

  try {
    while (offset < bytes.length) {
      const tag = varint();
      const field = Number(tag >> 3n);
      if (field < 1 || field > 0x1fffffff) return null;
      const wire = Number(tag & 7n);
      if (wire === 1 || wire === 5) {
        offset += wire === 1 ? 8 : 4;
        if (offset > bytes.length) return null;
        continue;
      }
      let value: WireValue;
      if (wire === 0) value = varint();
      else if (wire === 2) {
        const length = varint();
        if (length > BigInt(bytes.length - offset)) return null;
        const end = offset + Number(length);
        value = bytes.subarray(offset, end);
        offset = end;
      } else return null;
      const values = fields.get(field);
      if (values) values.push(value);
      else fields.set(field, [value]);
    }
    return fields;
  } catch {
    // Partial, malformed or unsupported protobuf is ignored, never guessed from strings.
    return null;
  }
}

function fieldBytes(fields: Fields | null, field: number): Uint8Array | null {
  const value = fields?.get(field)?.at(-1);
  return value instanceof Uint8Array ? value : null;
}

export function agyMessage(fields: Fields | null, field: number): Fields | null {
  return readAgyWire(fieldBytes(fields, field));
}

export function agyString(fields: Fields | null, field: number): string | null {
  const bytes = fieldBytes(fields, field);
  if (!bytes) return null;
  try {
    const value = utf8.decode(bytes);
    return value.trim() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ? value : null;
  } catch {
    return null; // Bytes at an unknown schema revision are not safe to display as text.
  }
}

export function agyInteger(fields: Fields | null, field: number): number | null {
  const value = fields?.get(field)?.at(-1);
  return typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}
