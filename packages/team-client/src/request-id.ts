const REQUEST_ID_BYTES = 16;

export function createTeamRequestId(randomBytes: (size: number) => Uint8Array): string {
  const bytes = randomBytes(REQUEST_ID_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.length !== REQUEST_ID_BYTES) {
    throw new Error("The random source must return 16 random bytes.");
  }
  let requestId = "";
  for (const byte of bytes) requestId += byte.toString(16).padStart(2, "0");
  return requestId;
}
