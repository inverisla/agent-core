// Runs one setup command, chosen by environment variables, for the admin job in Azure
// (where the database is private). Environment variables rather than command-line
// arguments, because `az containerapp job start --args` cannot pass options such as
// --name through.
//   ADMIN_COMMAND  tenant:create | tenant:add-user | tenant:sso
//   ADMIN_ARGS     a JSON array, e.g. ["--name", "Demo Ltd", "--admin-email", "you@example.com"]
const COMMANDS: Record<string, string> = {
  "tenant:create": "./create-tenant-cli.ts",
  "tenant:add-user": "./add-user-cli.ts",
  "tenant:sso": "./tenant-sso-cli.ts",
};

const command = process.env["ADMIN_COMMAND"] ?? "";
const script = COMMANDS[command];
let args: unknown;
try {
  args = JSON.parse(process.env["ADMIN_ARGS"] ?? "[]");
} catch {
  args = null;
}
if (!script || !Array.isArray(args) || !args.every((a) => typeof a === "string")) {
  console.error(
    `Set ADMIN_COMMAND to one of ${Object.keys(COMMANDS).join(", ")}, and ADMIN_ARGS to a JSON array of strings.`,
  );
  process.exit(1);
}
process.argv = [process.argv[0] ?? "node", script, ...args];
await import(script);
