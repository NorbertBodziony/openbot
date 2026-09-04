// Intentional product decision: account/device and logical remote sessions do not
// expire with time. Logout, device revocation, or membership revocation ends them.
// Keep a finite, Date-compatible deadline for existing numeric database/wire contracts.
// One-use pairing codes and connection tickets still have short expiration times.
export const PERSISTENT_SESSION_EXPIRES_AT = 8_640_000_000_000_000;
