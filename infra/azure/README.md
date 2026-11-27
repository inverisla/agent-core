# Azure dev environment

Everything lives in one resource group, `rg-agent-core-dev`, in West Europe (any UK or EU region works; see `AZURE_LOCATION`). GitHub Actions
deploys it (`.github/workflows/deploy.yml`) after CI passes on `main`, using an identity
that can only touch that resource group.

| What | Where |
| --- | --- |
| Web app (scales to zero) and worker | Azure Container Apps, in a private virtual network |
| Database | PostgreSQL Flexible Server 17, private only |
| Documents | Blob Storage, reached with managed identities (no keys): the web app's and the worker's, each its own |
| Secrets | Key Vault |
| Sign-in email | Azure Communication Services, data in the UK |
| Jobs | Temporal Cloud (Developer plan), API key in Key Vault |

The deploy runs in two stages: `foundation.bicep` (identities, Key Vault, registry), then
`ensure-secrets.sh` (creates the generated secrets once), then the images, then
`main.bicep` (everything else), then the migrate job, then a check of the dev URL.

## One-off setup

You need Owner rights on the subscription, the Azure CLI, and admin rights on the GitHub
repository. Run these in a shell where you are signed in (`az login`).

### 1. Resource groups, providers and the deploy identity

Run these in a bash shell. In Git Bash on Windows, first run `export MSYS_NO_PATHCONV=1`:
otherwise Git Bash turns Azure resource IDs such as `/subscriptions/…` into Windows paths
and Azure answers `MissingSubscription`. Every step is safe to run again (except after a region change: see "Changing region").

The deploy identity lives in a resource group of its own, `rg-agent-core-deploy`, where it
has no rights, so it cannot change its own access. In `rg-agent-core-dev` it is a
Contributor, and may grant only the six roles the templates use, only to managed
identities.

```bash
SUB=<subscription id>
REPO=<owner>/<repo>            # the GitHub repository, e.g. your-org/agent-core
RG=rg-agent-core-dev
LOCATION=westeurope            # a UK or EU region; set AZURE_LOCATION in step 3 to match
az account set --subscription "$SUB"
az group create -n "$RG" -l "$LOCATION" --tags project=agent-core env=dev
az group create -n rg-agent-core-deploy -l "$LOCATION" --tags project=agent-core env=dev
for p in Microsoft.App Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL Microsoft.Communication \
         Microsoft.KeyVault Microsoft.OperationalInsights Microsoft.Network Microsoft.Storage \
         Microsoft.ManagedIdentity Microsoft.CognitiveServices Microsoft.Insights; do az provider register -n "$p"; done
az identity create -g rg-agent-core-deploy -n id-agentcore-dev-github
CLIENT_ID=$(az identity show -g rg-agent-core-deploy -n id-agentcore-dev-github --query clientId -o tsv)
PRINCIPAL_ID=$(az identity show -g rg-agent-core-deploy -n id-agentcore-dev-github --query principalId -o tsv)
# Only GitHub Actions jobs in this repository's "dev" environment can use it.
az identity federated-credential create -g rg-agent-core-deploy --identity-name id-agentcore-dev-github \
  -n github-dev --issuer https://token.actions.githubusercontent.com \
  --subject "repo:$REPO:environment:dev" --audiences api://AzureADTokenExchange
SCOPE=$(az group show -n "$RG" --query id -o tsv)
az role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
  --role Contributor --scope "$SCOPE"
# Role-granting, limited to: Key Vault Secrets Officer and User, AcrPull, AcrPush,
# Storage Blob Data Contributor and Cognitive Services OpenAI User, for service
# principals (managed identities) only.
ROLES="b86a8fe4-44ce-4948-aee5-eccb2c155cd7, 4633458b-17de-408a-b874-0445c86b69e6, 7f951dda-4ed3-4680-a7ca-43fe172d538d, 8311e382-0749-4cb8-b61a-304f252e45ec, ba92f5b4-2d11-453d-a403-e96b0029c9fe, 5e0bd9bd-7b93-4f28-af87-19fc36ad61bd"
CONDITION="((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$ROLES} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$ROLES}))"
az role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
  --role "Role Based Access Control Administrator" --scope "$SCOPE" \
  --condition "$CONDITION" --condition-version 2.0
echo "AZURE_CLIENT_ID=$CLIENT_ID"; echo "AZURE_DEPLOY_PRINCIPAL_ID=$PRINCIPAL_ID"
echo "AZURE_TENANT_ID=$(az account show --query tenantId -o tsv)"; echo "AZURE_SUBSCRIPTION_ID=$SUB"
```

Some repositories send GitHub's newer subject format, with the owner's and repository's
numeric IDs: `repo:<owner>@<owner id>/<repo>@<repo id>:environment:dev`. If the first
deploy's sign-in step fails with `AADSTS700213: No matching federated identity record`,
copy the subject from that error and add a second credential with it. Check first that it
names your own repository and ends in `:environment:dev`:

```bash
az identity federated-credential create -g rg-agent-core-deploy --identity-name id-agentcore-dev-github \
  -n github-dev-ids --issuer https://token.actions.githubusercontent.com \
  --subject "<subject from the error>" --audiences api://AzureADTokenExchange
```

### 2. Temporal Cloud

Create a namespace in a UK or EU region (for example AWS `eu-west-2`, London), then an
API key for it. Note the namespace (for example `agentcore-dev.abc12`) and its gRPC
address (for example `eu-west-2.aws.api.temporal.io:7233`).

### 3. GitHub

In the repository's Settings → Environments, create an environment named `dev`. Under
"Deployment branches and tags", choose "Selected branches and tags" and add a rule for
`main`. Don't choose "Protected branches only": until `main` has a branch protection rule,
it lets every branch deploy. Add required reviewers too, if you want a person to approve
each deploy. Then add these as **environment secrets**. None of them is a password, but
together they identify your Azure tenant and environment, and a secret is masked in the
workflow logs, which anyone can read if the repository is public. (A variable of the same
name still works, but is printed in every step's log.)

| Secret | Value |
| --- | --- |
| `AZURE_CLIENT_ID`, `AZURE_DEPLOY_PRINCIPAL_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | From step 1 |
| `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` | From step 2 |
| `ENTRA_CLIENT_ID`, `OPERATOR_ENTRA_TENANT_ID`, `GOOGLE_CLIENT_ID` | Don't create these yet (step 6). GitHub can't store an empty value, and any value, even `N/A`, switches that sign-in on and makes the web app look for its secret in Key Vault |
| `ALERT_EMAIL` | Where alerts are emailed (task 14). Optional, but without it nobody is told. See `docs/operations.md` |

And these as **environment variables** (settings, not identifiers):

| Variable | Value |
| --- | --- |
| `AZURE_RESOURCE_GROUP` | `rg-agent-core-dev` |
| `POSTGRES_SKU` | Optional; defaults to `Standard_B1ms`. See below |
| `POSTGRES_BACKUP_DAYS` | Optional; days of Postgres point-in-time backups, 7 (default) to 35 |
| `POSTGRES_GEO_BACKUP` | Optional; `true` keeps backups in the paired region too. Only where the pair stays in the UK or EU |
| `AUDIT_RETENTION_DAYS` | Optional; days the audit log's write-once copy cannot be changed, default 30. Lock it in production: `docs/operations.md` |
| `AUDIT_POLICY_LOCKED`, `AUDIT_COPY_EPOCH` | Leave unset. Set only as `docs/operations.md` says: after locking the audit copy's policy, or after restoring the database |
| `AZURE_LOCATION` | Optional; defaults to `westeurope`. Must be a UK or EU region (the templates refuse others) |

**Postgres size.** A new subscription is sometimes refused `Standard_B1ms` in a region, and
the deploy then fails with `SkuNotAvailable`. The region's sizes are listed by
`az postgres flexible-server list-skus -l <region> -o table`, but that list does not show
what your subscription is refused, so try the next size up: `Standard_B2s` (Burstable,
roughly twice B1ms's compute cost), then `Standard_D2ds_v5` (General Purpose, about
£110–130 a month). Delete the failed server before re-running (portal → the server →
Delete). You can also ask Azure Support to allow B1ms (a free "Service and subscription
limits (quotas)" request). Changing the size of a running server later is supported; it
restarts the server, so expect a short outage during that deploy.

Then, under Settings → Variables → Actions, add the repository variable
`AZURE_DEPLOY_ENABLED` = `true`. Until it is set, the deploy workflow does nothing.

Optionally, to run CI and the deploy on cheaper runners, install a runner provider's GitHub
app (for example Ubicloud) on the repository and set the repository variable `CI_RUNNER` to
an x64 runner label (for example `ubicloud-standard-2-ubuntu-2404`, which matches GitHub's
`ubuntu-latest`). Unset, jobs use `ubuntu-latest`. If no runner serves the label (say the
app is not installed), jobs wait in the queue instead of failing. Pull requests from forks
always run on GitHub's runners. The deploy job runs there too, so the provider is trusted
with the deployment: its machine signs in to Azure, creates and reads the generated secrets
in Key Vault, and builds and pushes the images.

### 4. First deploy

Run the "Deploy dev" workflow by hand (Actions → Deploy dev → Run workflow). The first run
creates Key Vault and stops at "Generated secrets", asking for the Temporal API key. Give
yourself access to the vault and add it:

```bash
KV=$(az keyvault list -g "$RG" --query "[0].name" -o tsv)
az role assignment create --assignee "$(az ad signed-in-user show --query id -o tsv)" \
  --role "Key Vault Secrets Officer" --scope "$(az keyvault show -n "$KV" --query id -o tsv)"
az keyvault secret set --vault-name "$KV" --name temporal-api-key --value '<your Temporal API key>'
```

Run the workflow again. The dev URL is masked in the logs; find it on the web container
app's Overview page in the Azure portal (Application Url).

### Full and fast deploys

Most merges change only app code, so the deploy takes a fast path: it builds the images,
points the migrate and admin jobs at them, runs the migrations and updates the web app and
worker (a few minutes). It does a full deploy, with both Bicep stages and the secrets
(about 10 minutes), when anything under `infra/azure/` other than Markdown, or the deploy
workflow itself, or any `dev` setting passed to Bicep (such as `TEMPORAL_ADDRESS` or
`GOOGLE_CLIENT_ID`), has changed since the last full deploy, or when that one did not
finish cleanly. The run's summary says which path it took and why. To force a full deploy,
run "Deploy dev" by hand with "Full deploy" ticked.

### 5. Your first tenant

Once operator sign-in works (step 6, Microsoft), create tenants in the operator console:
Tenants, New tenant, with the first admin's email; the admin is emailed the portal's
sign-in address, and adds their own users under Admin, Users. The setup command below is
for before then, or if the console is unavailable.

The database is private, so setup commands run inside Azure, through the admin job. It
takes the command and its arguments as environment variables (`ADMIN_COMMAND`, and
`ADMIN_ARGS` as a JSON array). The script below starts it through Azure's API directly
(`az rest`), passing the image, command and database settings again, since a start with
your own settings replaces the job's template. (`az containerapp job start` can do the
same, but some versions of its CLI extension call an API version Azure refuses.) Save it
as a file with Unix (LF) line endings and run it with `bash`, with your own email address:
the sign-in link is sent there.

```bash
#!/usr/bin/env bash
set -euo pipefail
export MSYS_NO_PATHCONV=1
RG=rg-agent-core-dev
JOB=caj-agentcore-dev-admin
ADMIN_COMMAND=tenant:create
ADMIN_ARGS='[\"--name\",\"Demo Ltd\",\"--admin-email\",\"you@yourdomain.example\"]'
SUB=$(az account show --query id -o tsv | tr -d '\r')
IMAGE=$(az containerapp job show -g "$RG" -n "$JOB" --query 'properties.template.containers[0].image' -o tsv | tr -d '\r')
API="https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.App/jobs/$JOB"
trap 'rm -f admin-start.json' EXIT
cat > admin-start.json <<EOF
{
  "containers": [{
    "name": "admin",
    "image": "$IMAGE",
    "command": ["node"],
    "args": ["packages/db/src/admin-cli.ts"],
    "resources": { "cpu": 0.25, "memory": "0.5Gi" },
    "env": [
      { "name": "DATABASE_URL", "secretRef": "database-url" },
      { "name": "TENANT_CONTEXT_KEY", "secretRef": "tenant-context-key" },
      { "name": "ADMIN_COMMAND", "value": "$ADMIN_COMMAND" },
      { "name": "ADMIN_ARGS", "value": "$ADMIN_ARGS" }
    ]
  }]
}
EOF
EXECUTION=$(az rest --method post --body @admin-start.json --query name -o tsv \
  --url "$API/start?api-version=2024-03-01" | tr -d '\r')
echo "Started $EXECUTION. After a minute, check it with:"
echo "  MSYS_NO_PATHCONV=1 az rest --method get --query properties.status -o tsv --url '$API/executions/$EXECUTION?api-version=2024-03-01'"
```

`ADMIN_ARGS` is a JSON array written inside a JSON string, hence the `\"`; keep quotes and
backslashes out of the values. The other
commands work the same way, for example:

- `ADMIN_COMMAND=tenant:add-user` with
  `ADMIN_ARGS='[\"--slug\",\"demo-ltd\",\"--email\",\"someone@example.com\",\"--role\",\"admin\"]'`
- `ADMIN_COMMAND=tenant:sso` with `ADMIN_ARGS='[\"--slug\",\"demo-ltd\",\"--google\",\"yourdomain.example\"]'`

When the status is `Succeeded`, the output (for example `tenant created: /t/demo-ltd (admin …)`) is
in the job's logs: Azure portal → the job → Execution history → Logs. Once operator sign-in is set
up, manage tenants and users from the operator console and tenant admin pages instead;
this command-line route is for before then.

Then open `<dev URL>/t/demo-ltd/sign-in` and sign in with an email link: the email comes
from Azure Communication Services (check junk mail for an `azurecomm.net` sender). **This
is the check that task 6 is done**: the deploy's own check confirms the site answers and
can use its database (`/api/ready`), but only a real sign-in proves email and sessions
work.

### 6. Microsoft and Google sign-in (optional, but needed for the operator console)

The operator console (`<dev URL>/operator`) is only for the client's own staff, who sign
in with Microsoft: a member (not a guest) of the client's own Microsoft organisation, with
the app role **Operator**. Until this step is done the console is closed; the setup
commands (step 5) do the same jobs meanwhile.

**Microsoft** (operators, and tenants that sign in with Microsoft):

1. In the Azure portal, Microsoft Entra ID, App registrations, New registration: any name
   (for example "Agent core dev"), supported account types **Multiple Entra ID tenants**
   (older portals: "Accounts in any organizational directory (multitenant)"), so tenants
   can sign in from their own organisations; not the option that adds personal Microsoft
   accounts, which are refused anyway. If the portal then asks which organisations, choose
   **Allow all tenants**: the app itself admits only your own organisation's operators and
   each tenant's linked organisation, and "Allow only certain tenants" would mean adding
   every linked organisation there too. Redirect URI platform Web,
   `<dev URL>/api/auth/callback/microsoft-entra-id`.
2. On the registration:
   - **App roles**, Create app role: display name and value `Operator`, allowed member
     types "Users/Groups".
   - **Token configuration**, Add optional claim, ID token: `xms_edov` (whether an email
     address's domain is verified by its organisation; email addresses are only trusted
     with it).
   - **Certificates & secrets**, New client secret: store its value in Key Vault as
     `entra-client-secret`, with its **Value** (shown once), not its Secret ID. Note when
     it expires: sign-in stops then.

     ```bash
     RG=rg-agent-core-dev
     KV=$(az keyvault list -g "$RG" --query "[0].name" -o tsv)
     az keyvault secret set --vault-name "$KV" -n entra-client-secret --value '<value>'
     ```

     (A permission error means your Key Vault access from step 4 has gone: run its
     `az role assignment create` command again.)
3. Give yourself, and any other operators, the role: Entra ID, Enterprise applications,
   the app, Users and groups, Add user/group, the person, role **Operator**. (Removing the
   role ends their operator access within an hour, the length of an operator session.)
4. In the GitHub `dev` environment, add the secrets `ENTRA_CLIENT_ID` (the registration's
   Application (client) ID) and `OPERATOR_ENTRA_TENANT_ID` (your organisation's Directory
   (tenant) ID, on the registration's Overview).

**Google** (tenants that sign in with Google Workspace; never operators): in Google Cloud,
create an OAuth client of type Web application with the redirect URI
`<dev URL>/api/auth/callback/google`; store its secret as `google-client-secret` in Key
Vault and add `GOOGLE_CLIENT_ID` as a `dev` environment secret.

Run the deploy again to apply them (changed settings make it a full deploy). Then sign in at
`<dev URL>/operator`. Microsoft asks which account to use every time, so a first try with
the wrong account is not remembered. The first sign-in from an organisation shows
Microsoft's consent screen: an admin of that organisation can tick "Consent on behalf of
your organization" (or grant it under Enterprise applications, the app, Permissions). If
the organisation has turned off user consent, an admin must do this before anyone else
can sign in. Tenants' organisations usually need an admin's approval first (below).

A tenant's own Microsoft or Google sign-in is linked from there: Tenants, the tenant, Work
account sign-in. Its admins can then turn off email links on their Sign-in settings page,
once they have signed in with their work account.

**Before a tenant's staff sign in with Microsoft**, their organisation should approve the
app once. Most organisations only let staff approve apps from verified publishers, so
otherwise their staff see "Need admin approval". Send the tenant's IT admin (a Global,
Privileged Role, Cloud Application or Application Administrator in their organisation)
this link, with their own Directory (tenant) ID, the one you linked, and your values:

```
https://login.microsoftonline.com/<their directory ID>/v2.0/adminconsent
  ?client_id=<ENTRA_CLIENT_ID>&scope=openid%20profile%20email
  &redirect_uri=<dev URL>/api/auth/callback/microsoft-entra-id
```

(One line, without the spaces; the same link, with your own directory ID, approves the app
for your own organisation.) They sign in and accept, then land on this app's "Sign-in
failed" page: ignore it, the approval is saved. It covers everyone in their organisation,
and only the sign-in permissions the app asks for (`openid`, `profile`, `email`).

For a deployment real customers use, consider also becoming a **verified publisher** (the
registration's Branding & properties, Publisher verification; it needs a Microsoft AI
Cloud Partner Program ID and a verified custom domain as the publisher domain). Users in
organisations that allow it can then approve the app themselves, and Microsoft shows your
verified name on its consent screen.

**If your Azure account is a personal Microsoft account** (for example one made with a
Gmail or Outlook.com address), it is an external account in your directory, not a member,
and the console refuses it (the page says "Sign-in was refused"; the web app's log has a
`sign-in.refused` line with `"reason":"guest-account"`). Make a member account for operating:

1. Entra ID, Users, New user, Create new user: a user principal name such as
   `operator@<your directory>.onmicrosoft.com`, and note the temporary password it shows
   (Auto-generate password).
2. Give that user the Operator role (Microsoft point 3 above: Enterprise applications,
   the app, Users and groups).
3. Approve the app for the organisation once, signed in as your own (owner) account: open
   the admin-consent link above with your own `OPERATOR_ENTRA_TENANT_ID` as the directory
   ID, and accept. You then land on this app's "Sign-in failed" page: ignore it, the
   approval is saved.
4. In a private window, sign in at `<dev URL>/operator` with the new account, and set its
   password, and Microsoft Authenticator, when asked.

**If sign-in keeps failing after a wrong try** ("Sign-in could not be completed"), try a
private window, or clear the site's cookies: a half-finished earlier sign-in can get in
the way. The web app's log says what went wrong (a `sign-in.refused` line with its reason, or
`sign-in error: <type>`; Container Apps, the web app, Log stream).

### 7. Azure OpenAI (optional, when the agents need a model)

The Bicep creates an Azure OpenAI account and one model deployment, of the Data Zone
Standard (EU) type, only when `AZURE_OPENAI_ENABLED` is `true`. It costs nothing until
then, and is charged per token after. Key sign-in is off: the worker uses its own managed
identity, which the deploy gives the "Cognitive Services OpenAI User" role (the web app
never calls the model, so it has no access).

Until it is on, uploads still work but their jobs fail with `no-model`: the demo agent
needs a model to fill in its fields.

1. **Register Azure OpenAI's provider** (once per subscription; new setups did this in
   step 1). Without it the deploy fails with `MissingSubscriptionRegistration`:

   ```bash
   az provider register -n Microsoft.CognitiveServices --wait
   ```

2. **Let the deploy identity grant that role** (once). Only for a setup made from an
   earlier version of this README, whose condition allows five roles (step 1 now allows
   six). This script changes the condition on the existing role-granting assignment in
   place (Azure allows one assignment per identity, role and
   scope, so a second cannot be added beside it). Save it as a file and run it with
   `bash`:

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   export MSYS_NO_PATHCONV=1
   RG=rg-agent-core-dev
   SCOPE=$(az group show -n "$RG" --query id -o tsv | tr -d '\r')
   PRINCIPAL_ID=$(az identity show -g rg-agent-core-deploy -n id-agentcore-dev-github --query principalId -o tsv | tr -d '\r')
   ROLES="b86a8fe4-44ce-4948-aee5-eccb2c155cd7, 4633458b-17de-408a-b874-0445c86b69e6, 7f951dda-4ed3-4680-a7ca-43fe172d538d, 8311e382-0749-4cb8-b61a-304f252e45ec, ba92f5b4-2d11-453d-a403-e96b0029c9fe, 5e0bd9bd-7b93-4f28-af87-19fc36ad61bd"
   CONDITION="((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$ROLES} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$ROLES}))"
   read -r ID ROLE_DEF < <(az role assignment list --scope "$SCOPE" --role "Role Based Access Control Administrator" \
     --query "[?principalId=='$PRINCIPAL_ID'] | [0].[id, roleDefinitionId]" -o tsv | tr -d '\r')
   [ -n "${ID:-}" ] || { echo "No role-granting assignment found for the deploy identity: see step 1."; exit 1; }
   trap 'rm -f rbac-update.json' EXIT
   cat > rbac-update.json <<EOF
   {
     "id": "$ID",
     "name": "${ID##*/}",
     "principalId": "$PRINCIPAL_ID",
     "principalType": "ServicePrincipal",
     "roleDefinitionId": "$ROLE_DEF",
     "scope": "$SCOPE",
     "condition": "$CONDITION",
     "conditionVersion": "2.0"
   }
   EOF
   az role assignment update --role-assignment @rbac-update.json -o none
   az role assignment list --scope "$SCOPE" --role "Role Based Access Control Administrator" \
     --query "[?principalId=='$PRINCIPAL_ID'] | [0].condition" -o tsv | grep -q 5e0bd9bd && echo "Updated."
   ```

   New setups (step 1 as it is now) already include this role.

3. **Choose a model** that Azure offers as Data Zone Standard in your region (prices and
   models change, so check the current list). The EU data zone covers EU regions such as
   West Europe; it may not be offered in UK South:

   ```bash
   az cognitiveservices model list -l westeurope \
     --query "[?model.skus[?name=='DataZoneStandard']].{name:model.name, version:model.version}" -o table
   ```

4. **Set the `dev` environment variables** `AZURE_OPENAI_ENABLED=true`,
   `AZURE_OPENAI_MODEL` and `AZURE_OPENAI_MODEL_VERSION` (and optionally
   `AZURE_OPENAI_CAPACITY`, in thousands of tokens per minute, default 10), and run the
   deploy. It takes the full path, since these are settings passed to Bicep.
5. **Add the model's price** to `packages/core/src/models/prices.json`
   (`"azure-openai/<model>"`, US dollars per million input and output tokens, from Azure's
   price page for Data Zone Standard), so calls are recorded with a cost.
6. **Check it from your machine**: give your own account the "Cognitive Services OpenAI
   User" role on the account, sign in with `az login`, put `MODEL_PROVIDER`,
   `AZURE_OPENAI_ENDPOINT` (the account's endpoint), `AZURE_OPENAI_DEPLOYMENT` and
   `AZURE_OPENAI_MODEL` in `.env.local`, and run `pnpm model:smoke`. It makes one short call
   and prints the model, tokens and cost.

Bedrock (Claude, the second provider) needs no Azure resources: an AWS account in an EU
region with model access, and a Bedrock API key, stored in Key Vault when it is used for
real. See `docs/models.md`.

### 8. Test agent (optional, for testing prompts)

The "Test agent" workflow (`.github/workflows/test-agent.yml`) runs each demo agent's
test set (the sample contracts) with the dev model, for the agent on the branch and where
the branch left `main`, and shows the two side by side, accuracy per field
(`pnpm agent:compare`). A change to shared code only, not the agent, is measured rather
than compared, and the report says so. It can run from any branch, to test a prompt
before merging, so it does not use the deploy identity: it has an identity of its own
with the "Cognitive Services OpenAI User" role on the dev Azure OpenAI account and
nothing else. That role covers the account's data plane: calling its models, and reading
what the account stores (the app stores nothing there: it sends no `store` flag). Anyone
who can push a branch can use it, and its calls share the dev deployment's capacity, so a
burst of runs can slow dev jobs. Do this after step 7.

1. **Create the identity** (once). Its sign-in uses the same subject format as the deploy
   identity's, with `samples` in place of `dev`. Save as a file and run it with `bash`:

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   export MSYS_NO_PATHCONV=1
   ID_RG=rg-agent-core-deploy
   az identity create -g "$ID_RG" -n id-agentcore-dev-samples -o none
   n=0
   for subject in $(az identity federated-credential list -g "$ID_RG" --identity-name id-agentcore-dev-github \
       --query "[].subject" -o tsv | tr -d '\r'); do
     case "$subject" in *:environment:dev) ;; *) continue ;; esac
     n=$((n + 1))
     az identity federated-credential create -g "$ID_RG" --identity-name id-agentcore-dev-samples \
       -n "github-samples-$n" --issuer https://token.actions.githubusercontent.com \
       --subject "${subject%:environment:dev}:environment:samples" --audiences api://AzureADTokenExchange -o none
   done
   echo "Sign-in subjects added: $n (0 means the deploy identity's were not found: see step 1)"
   ACCOUNT=$(az cognitiveservices account list -g rg-agent-core-dev --query "[0].name" -o tsv | tr -d '\r')
   [ -n "$ACCOUNT" ] || { echo "No Azure OpenAI account in rg-agent-core-dev: do step 7 first."; exit 1; }
   # "Cognitive Services OpenAI User" on the account: call the model, nothing else.
   # Safe to run again: an existing assignment is reported, not an error.
   az role assignment create -o none --assignee-principal-type ServicePrincipal \
     --assignee-object-id "$(az identity show -g "$ID_RG" -n id-agentcore-dev-samples --query principalId -o tsv | tr -d '\r')" \
     --role 5e0bd9bd-7b93-4f28-af87-19fc36ad61bd \
     --scope "$(az cognitiveservices account show -g rg-agent-core-dev -n "$ACCOUNT" --query id -o tsv | tr -d '\r')" \
     || echo "(The role assignment exists already, or see the error above.)"
   echo "AZURE_CLIENT_ID=$(az identity show -g "$ID_RG" -n id-agentcore-dev-samples --query clientId -o tsv)"
   echo "AZURE_TENANT_ID=$(az account show --query tenantId -o tsv)"
   echo "AZURE_OPENAI_ENDPOINT=$(az cognitiveservices account show -g rg-agent-core-dev -n "$ACCOUNT" --query properties.endpoint -o tsv)"
   ```

   The role is on the account itself, so if the account is ever created again (a new
   region, say), run the script again.

2. **In GitHub** (Settings, Environments):
   - Create an environment named `samples`, with no branch rules (so a branch can test a
     prompt; the identity can only call the model). Add the first three as **environment
     secrets** (identifiers, masked in logs as in step 3) and the last two as **environment
     variables**:

     | Name | Value |
     | --- | --- |
     | `AZURE_CLIENT_ID` (secret) | From the script (the samples identity, not the deploy identity) |
     | `AZURE_TENANT_ID` (secret) | From the script |
     | `AZURE_OPENAI_ENDPOINT` (secret) | From the script, for example `https://oai-agentcore-dev-abc123.openai.azure.com/` |
     | `AZURE_OPENAI_DEPLOYMENT` | The deployment's name, which is the model's name: `gpt-5.4-mini` |
     | `AZURE_OPENAI_MODEL` | The model's name, for prices and records: `gpt-5.4-mini` |

3. **Run it**: it runs by itself on a push to a branch that changes the agent or the
   samples, or by hand (Actions, "Test agent", Run workflow) once it is on `main`. The
   run's summary page shows the two versions side by side; the HTML report is in its
   artifact. A run (3 repeats of each case, for each version) costs about 10 US cents.
   It makes about 60 model calls, which the default capacity (10,000 tokens a minute)
   only allows slowly: rate-limited calls wait and try again, so the run takes longer
   rather than failing. Setting `AZURE_OPENAI_CAPACITY` to 50 in step 7 makes it a few
   minutes; capacity costs nothing until it is used.

## What is reachable from the internet

- The web app (HTTPS only).
- Key Vault and the container registry, because the CI runners (GitHub's, or the `CI_RUNNER` provider's) write secrets and push
  images; both accept only Entra sign-ins with the right role (no keys or anonymous access).
- Nothing else: Postgres has no public address, Blob Storage accepts only the apps'
  subnet, and the worker and jobs have no ingress.

## Good to know

- **Setups made from an earlier version of this README** registered every provider but `Microsoft.Insights`, which
  Application Insights and the alerts (`docs/operations.md`) need. Without it the deploy
  fails with `MissingSubscriptionRegistration`. Register it once, as a subscription Owner
  (the deploy identity cannot), then run the deploy again:
  `az provider register -n Microsoft.Insights --wait`
- **Who can read which secret.** The web app runs as `id-agentcore-dev-app` and the
  worker as `id-agentcore-dev-worker` (database URL, tenant context key and Temporal key
  only); each can read only its own secrets, one by one. A new identity's access can take
  a few minutes to take effect, so the deploy tries its apps stage once more after a wait
  if the first try fails; if that fails too, run the deploy again. The migrate and admin jobs run as
  `id-agentcore-dev-ops`, the only identity that can read the database admin credentials.
- **Rotating a secret** (for example the Temporal API key): update it in Key Vault, then
  restart the apps (or deploy again); running copies keep the old value until they restart.
- **Deleting the resource group**: Key Vault keeps a deleted vault for 30 days, so
  recreating it under the same name needs `az keyvault purge` first.

## Changing region

Resources cannot move between regions, so a region change means rebuilding. Resource names
include the region, so the new ones do not clash with the old soft-deleted Key Vault and
Log Analytics workspace. The deploy identity and `rg-agent-core-deploy` stay where they are
(they hold no data, so their region does not matter).

1. **Stop deploys first.** Set the repository variable `AZURE_DEPLOY_ENABLED` to `false`
   before merging any change that moves region. A deploy into the old group would create a
   vault under the new name there, and deleting the group would then leave that name
   soft-deleted. If that happened, `az keyvault list-deleted` shows it and
   `az keyvault purge -n <name>` frees the name.
2. **Rebuild the group and the deploy identity's roles.** In Git Bash (save as a file and
   run it with `bash`):

   ```bash
   set -euo pipefail
   export MSYS_NO_PATHCONV=1
   SUB="<subscription name or id>"
   az account set --subscription "$SUB"
   echo "Working in subscription: $(az account show --query name -o tsv)"
   RG=rg-agent-core-dev
   LOCATION=westeurope   # the new region
   PRINCIPAL_ID=$(az identity show -g rg-agent-core-deploy -n id-agentcore-dev-github --query principalId -o tsv)
   az group delete -n "$RG" --yes   # also removes the roles and the ME_… group
   az group create -n "$RG" -l "$LOCATION" --tags project=agent-core env=dev -o none
   SCOPE=$(az group show -n "$RG" --query id -o tsv)
   az role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
     --role Contributor --scope "$SCOPE" -o none
   ROLES="b86a8fe4-44ce-4948-aee5-eccb2c155cd7, 4633458b-17de-408a-b874-0445c86b69e6, 7f951dda-4ed3-4680-a7ca-43fe172d538d, 8311e382-0749-4cb8-b61a-304f252e45ec, ba92f5b4-2d11-453d-a403-e96b0029c9fe, 5e0bd9bd-7b93-4f28-af87-19fc36ad61bd"
   CONDITION="((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$ROLES} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$ROLES}))"
   az role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
     --role "Role Based Access Control Administrator" --scope "$SCOPE" \
     --condition "$CONDITION" --condition-version 2.0 -o none
   az role assignment list --scope "$SCOPE" --query "[?principalId=='$PRINCIPAL_ID'].roleDefinitionName" -o tsv
   ```

   It should end by listing `Contributor` and `Role Based Access Control Administrator`.
3. **Deploy.** Set `AZURE_LOCATION` on the GitHub `dev` environment, set
   `AZURE_DEPLOY_ENABLED` back to `true`, and run the deploy. It makes new secrets and stops
   at `temporal-api-key`: give yourself access to the new vault and add the key (step 4),
   then run it again.
4. **The dev URL changes.** Update any Entra or Google redirect URIs (step 6) and store their
   client secrets in the new vault again.

## Cost

Roughly £50–70 a month, mostly Postgres (Burstable B1ms; more with a larger `POSTGRES_SKU`) and the always-on worker; the web
app scales to zero when idle. Check with the Azure pricing calculator before relying on it.
