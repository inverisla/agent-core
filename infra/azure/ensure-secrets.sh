#!/usr/bin/env bash
# Creates the generated secrets in Key Vault on the first deploy; never overwrites one
# that exists, and stops on any error other than "not found", so a passing glitch can
# never replace a password in use. Usage: ensure-secrets.sh <key-vault> <postgres-server>
# Secrets only you can provide are checked, not created:
#   temporal-api-key (required), entra-client-secret and google-client-secret (if used).
set -euo pipefail
vault="$1"
server="$2"
fqdn="${server}.postgres.database.azure.com"

# present | missing; exits on any other error.
state() {
  local err
  if err=$(az keyvault secret show --vault-name "$vault" --name "$1" --query id -o tsv 2>&1 >/dev/null); then
    echo present
  elif grep -q "SecretNotFound" <<<"$err"; then
    echo missing
  else
    echo "::error::Could not check Key Vault secret $1: $err" >&2
    exit 1
  fi
}
get() { az keyvault secret show --vault-name "$vault" --name "$1" --query value -o tsv; }
# In GitHub Actions, hides a value from the logs from here on (public for a public repo),
# in case an error ever prints it. Says nothing when run by hand.
mask() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$1"; fi; }
# The value goes through a private temporary file, not the command line.
put() {
  local file
  mask "$2"
  file=$(mktemp)
  chmod 600 "$file"
  printf '%s' "$2" >"$file"
  az keyvault secret set --vault-name "$vault" --name "$1" --file "$file" --encoding utf-8 --output none
  rm -f "$file"
  echo "created $1"
}
# Letters and digits only, so passwords need no escaping in URLs.
# No head in the pipe: head closing early could fail it under pipefail.
password() {
  local p
  p=$(openssl rand -base64 60 | tr -dc 'A-Za-z0-9')
  [ "${#p}" -ge 40 ] || { echo "::error::Could not generate a password." >&2; exit 1; }
  printf '%s' "${p:0:40}"
}

# A new role assignment on the vault can take a few minutes to apply.
for i in $(seq 1 20); do
  if az keyvault secret list --vault-name "$vault" --query "[0].id" -o tsv >/dev/null 2>&1; then break; fi
  if [ "$i" = 20 ]; then echo "::error::No access to Key Vault $vault after 5 minutes."; exit 1; fi
  echo "waiting for Key Vault access ($i)"; sleep 15
done

# Each check is its own statement, so an error from Key Vault (anything but "not found")
# stops the script here (set -e). Inside a test or as an argument, the error would be
# lost, and a secret in use could be replaced or a missing one passed over.
s=$(state pg-admin-password)
if [ "$s" = missing ]; then v=$(password); put pg-admin-password "$v"; fi
s=$(state app-db-password)
if [ "$s" = missing ]; then v=$(password); put app-db-password "$v"; fi
s=$(state tenant-context-key)
if [ "$s" = missing ]; then v=$(openssl rand -base64 32); put tenant-context-key "$v"; fi
s=$(state auth-secret)
if [ "$s" = missing ]; then v=$(openssl rand -base64 32); put auth-secret "$v"; fi
# Read into a variable first, so it is masked on its own before it goes into a URL.
s=$(state database-url)
if [ "$s" = missing ]; then
  pw=$(get app-db-password)
  mask "$pw"
  put database-url "postgres://agentcore_app:${pw}@${fqdn}:5432/agentcore?sslmode=require"
fi
s=$(state database-admin-url)
if [ "$s" = missing ]; then
  pw=$(get pg-admin-password)
  mask "$pw"
  put database-admin-url "postgres://agentcoreadmin:${pw}@${fqdn}:5432/agentcore?sslmode=require"
fi

missing=0
s=$(state temporal-api-key)
if [ "$s" = missing ]; then
  echo "::error::Key Vault $vault has no temporal-api-key. Add your Temporal Cloud API key (see infra/azure/README.md, step 4)."
  missing=1
fi
for optional in entra-client-secret google-client-secret; do
  s=$(state "$optional")
  [ "$s" = present ] || echo "note: $optional not set (only needed if that sign-in is configured)"
done
exit "$missing"
