// The workflows' logs are public once the repository is: whatever identifies the
// environment, or is secret, is masked before it can be printed.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..");
const WORKFLOWS = path.join(ROOT, ".github", "workflows");
const read = (file: string) => readFileSync(file, "utf8");
const workflows = readdirSync(WORKFLOWS)
  .filter((f) => f.endsWith(".yml"))
  .map((f) => ({ name: f, text: read(path.join(WORKFLOWS, f)) }));

describe("public workflow logs", () => {
  it("masks every value the deploy writes to GITHUB_ENV (names and addresses identify it)", () => {
    const lines = read(path.join(WORKFLOWS, "deploy.yml")).split("\n");
    const unmasked = lines.flatMap((line, i) =>
      line.includes('>> "$GITHUB_ENV"') &&
      !line.includes("::add-mask::") &&
      !(lines[i - 1] ?? "").includes("::add-mask::")
        ? [`deploy.yml:${i + 1}: ${line.trim()}`]
        : [],
    );
    expect(unmasked).toEqual([]);
    // Addresses are masked as bare hosts too, on both paths: curl names only the host.
    expect(lines.filter((l) => l.includes('echo "::add-mask::${v#*://}"'))).toHaveLength(2);
  });

  it("leaves no git token on disk after any checkout", () => {
    const missing = workflows.flatMap(({ name, text }) =>
      text
        .split(/\n(?=\s*- (?:uses|name|run):)/)
        .filter((step) => /uses: actions\/checkout@/.test(step))
        .filter((step) => !/persist-credentials: false/.test(step))
        .map(() => name),
    );
    expect(workflows.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it("masks each generated or read secret in the Key Vault setup script", () => {
    const script = read(path.join(ROOT, "infra", "azure", "ensure-secrets.sh"));
    // Every value stored goes through put, which masks it first.
    expect(script).toMatch(/put\(\) \{\n\s+local file\n\s+mask "\$2"/);
    // Every value read back is masked before use.
    const reads = script.match(/(\w+)=\$\(get [\w-]+\)\n\s+mask "\$\1"/g) ?? [];
    expect(reads).toHaveLength((script.match(/\$\(get /g) ?? []).length);
    // Only in GitHub Actions: run by hand, it prints nothing.
    expect(script).toContain('if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$1"; fi');
  });
});

/** Runs ensure-secrets.sh against a stand-in az; returns its exit code and the secrets it set. */
function ensureSecrets(present: string[], failing: string[] = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "ensure-secrets-"));
  try {
    const az = path.join(dir, "az");
    // keyvault secret list: access works. show --query id: present, missing
    // (SecretNotFound) or failing (some other error). show --query value: a value.
    // set: logs the secret's name.
    writeFileSync(
      az,
      `#!/usr/bin/env bash
args="$*"; name=""; prev=""
for a in "$@"; do [ "$prev" = "--name" ] && name="$a"; prev="$a"; done
case "$args" in
  *"secret list"*) echo id ;;
  *"secret set"*) echo "$name" >> "${dir}/set.log" ;;
  *"--query value"*) echo value ;;
  *"secret show"*)
    case " ${failing.join(" ")} " in *" $name "*) echo "Forbidden" >&2; exit 1 ;; esac
    case " ${present.join(" ")} " in *" $name "*) echo id ;; *) echo "SecretNotFound" >&2; exit 1 ;; esac ;;
esac
`,
    );
    chmodSync(az, 0o755);
    const run = spawnSync(
      "bash",
      [path.join(ROOT, "infra", "azure", "ensure-secrets.sh"), "kv", "pg"],
      {
        env: { PATH: `${dir}:${process.env["PATH"] ?? ""}` },
        encoding: "utf8",
      },
    );
    let set: string[] = [];
    try {
      set = readFileSync(path.join(dir, "set.log"), "utf8").trim().split("\n").filter(Boolean);
    } catch {
      // nothing set
    }
    return { status: run.status, set, output: run.stdout + run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// These run the script with bash and openssl, which CI has; a Windows machine may not.
describe.skipIf(process.platform === "win32")("the Key Vault setup script", () => {
  it("creates only the missing secrets, and prints no secret when run by hand", () => {
    const { status, set, output } = ensureSecrets(["temporal-api-key", "auth-secret"]);
    expect(status).toBe(0);
    expect(set.sort()).toEqual(
      [
        "pg-admin-password",
        "app-db-password",
        "tenant-context-key",
        "database-url",
        "database-admin-url",
      ].sort(),
    );
    expect(output).not.toContain("::add-mask::");
  });

  it("stops at an error from Key Vault, and never replaces a secret because of one", () => {
    for (const name of ["pg-admin-password", "auth-secret", "database-url", "temporal-api-key"]) {
      const { status, set } = ensureSecrets(["temporal-api-key"], [name]);
      expect(status, name).not.toBe(0);
      expect(set, name).not.toContain(name);
    }
  });
});
