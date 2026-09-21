const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Compare UUID text without rewriting identity/fingerprint inputs. */
export function sameUuid(left: string, right: string | undefined): boolean {
  if (left === right) return true;
  return (
    right !== undefined &&
    uuidPattern.test(left) &&
    uuidPattern.test(right) &&
    left.toLowerCase() === right.toLowerCase()
  );
}
