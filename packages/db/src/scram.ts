// A Postgres SCRAM-SHA-256 password verifier, computed here so the password itself never
// reaches the server: ALTER ROLE ... PASSWORD with a verifier stores it as given, and
// statement statistics or logs then hold only the verifier.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

export function scramSha256Verifier(
  password: string,
  salt = randomBytes(16),
  iterations = 4096,
): string {
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}
