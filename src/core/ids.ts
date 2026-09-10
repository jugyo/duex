import { randomUUID, randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Lexicographically sortable, ULID-shaped id: 48-bit timestamp + 80-bit random.
 * Sortability keeps `invocations list` in creation order without a join.
 */
export function newInvocationId(now: number = Date.now()): string {
  let timePart = "";
  let remaining = now;
  for (let index = 0; index < 10; index += 1) {
    timePart = CROCKFORD[remaining % 32] + timePart;
    remaining = Math.floor(remaining / 32);
  }
  const bytes = randomBytes(16);
  let randomPart = "";
  for (let index = 0; index < 16; index += 1) {
    randomPart += CROCKFORD[bytes[index] % 32];
  }
  return timePart + randomPart;
}

export function newOwnerId(): string {
  return `${process.pid}-${randomUUID()}`;
}

export { randomUUID };
