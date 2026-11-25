// Stage 2 of the dev environment: network, Postgres, storage, email and the container
// apps. Deployed after foundation.bicep and infra/azure/ensure-secrets.sh, which put the
// generated secrets in Key Vault.
targetScope = 'resourceGroup'

@description('Azure region; must match the one foundation.bicep was deployed with.')
@allowed([
  'uksouth'
  'ukwest'
  'westeurope'
  'northeurope'
  'francecentral'
  'germanywestcentral'
  'swedencentral'
  'italynorth'
  'polandcentral'
  'spaincentral'
])
param location string = 'westeurope'
param environmentName string = 'dev'

@description('Image tag to deploy (the git commit).')
param imageTag string

param keyVaultName string
param registryLoginServer string
param appIdentityName string
param opsIdentityName string
param workerIdentityName string
param postgresServerName string
@description('Name suffix from foundation.bicep (it includes the region).')
param nameSuffix string

@description('Postgres compute size, e.g. Standard_B1ms. Set the POSTGRES_SKU variable on the GitHub dev environment to change it.')
param postgresSku string = 'Standard_B1ms'

@description('False on the first pass of a deploy (infrastructure and jobs only), so migrations run before the apps change.')
param deployApps bool = true

@description('Temporal Cloud gRPC address and namespace. The API key is the Key Vault secret temporal-api-key.')
param temporalAddress string
param temporalNamespace string

@description('Microsoft sign-in: the Entra app registration client ID. Empty turns it off. Its secret is entra-client-secret in Key Vault.')
param entraClientId string = ''
@description('The client\'s own Entra tenant ID, whose members with the Operator app role may use the operator console.')
param operatorEntraTenantId string = ''
@description('Google sign-in: the OAuth client ID. Empty turns it off. Its secret is google-client-secret in Key Vault.')
param googleClientId string = ''

@description('Azure OpenAI (task 8): off until the agents need a model. Set AZURE_OPENAI_ENABLED to turn it on.')
param azureOpenAiEnabled bool = false
@description('The model to deploy, and its version, as Azure lists them for Data Zone Standard in this region.')
param azureOpenAiModel string = ''
param azureOpenAiModelVersion string = ''
@description('Deployment capacity, in thousands of tokens per minute.')
param azureOpenAiCapacity int = 10

@description('Where alerts are emailed (the ALERT_EMAIL variable). Empty: alerts fire, nobody is told.')
param alertEmail string = ''
@description('Days of Postgres point-in-time backups, 7 to 35 (POSTGRES_BACKUP_DAYS).')
param postgresBackupDays int = 7
@description('Keep Postgres backups in the paired region too (POSTGRES_GEO_BACKUP). Only where the pair stays in the UK or EU.')
param postgresGeoBackup bool = false
@description('Days deleted or overwritten documents and reports can be restored (soft delete, versions, point-in-time restore).')
@minValue(1)
@maxValue(364)
param blobRestoreDays int = 7
@description('Days each audit log copy cannot be changed or deleted (AUDIT_RETENTION_DAYS). Unlocked here; see docs/operations.md before locking it.')
@minValue(1)
param auditRetentionDays int = 30
@description('True once the audit copy\'s retention policy has been locked (AUDIT_POLICY_LOCKED): a locked policy cannot be written again, so the deploy leaves it alone.')
param auditPolicyLocked bool = false
@description('Starts a fresh audit copy after the database is restored to an earlier point (AUDIT_COPY_EPOCH; docs/operations.md).')
@minValue(1)
param auditCopyEpoch int = 1

// Taken from foundation.bicep's output, so names in both stages always agree.
var suffix = nameSuffix
var tags = { project: 'agent-core', env: environmentName }
var webAppName = 'ca-agentcore-${environmentName}-web'
var workerAppName = 'ca-agentcore-${environmentName}-worker'
var storageBlobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: appIdentityName
}

resource opsIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: opsIdentityName
}

resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: workerIdentityName
}

// Each identity may read only the secrets it uses (Key Vault Secrets User per secret).
var secretsUser = '4633458b-17de-408a-b874-0445c86b69e6'
var appSecretNames = concat(
  ['database-url', 'tenant-context-key', 'auth-secret', 'temporal-api-key'],
  empty(entraClientId) ? [] : ['entra-client-secret'],
  empty(googleClientId) ? [] : ['google-client-secret']
)
var opsSecretNames = ['database-admin-url', 'app-db-password', 'tenant-context-key', 'database-url']
var workerSecretNames = ['database-url', 'tenant-context-key', 'temporal-api-key']

resource appSecrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = [
  for name in appSecretNames: { parent: keyVault, name: name }
]
resource opsSecrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = [
  for name in opsSecretNames: { parent: keyVault, name: name }
]
resource workerSecrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = [
  for name in workerSecretNames: { parent: keyVault, name: name }
]

resource appSecretAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (name, i) in appSecretNames: {
    name: guid(keyVault.id, name, appIdentity.id, secretsUser)
    scope: appSecrets[i]
    properties: {
      principalId: appIdentity.properties.principalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUser)
    }
  }
]
resource workerSecretAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (name, i) in workerSecretNames: {
    name: guid(keyVault.id, name, workerIdentity.id, secretsUser)
    scope: workerSecrets[i]
    properties: {
      principalId: workerIdentity.properties.principalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUser)
    }
  }
]
resource opsSecretAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (name, i) in opsSecretNames: {
    name: guid(keyVault.id, name, opsIdentity.id, secretsUser)
    scope: opsSecrets[i]
    properties: {
      principalId: opsIdentity.properties.principalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUser)
    }
  }
]

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-agentcore-${environmentName}-${suffix}'
  location: location
  tags: tags
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

// Subnet IDs are built from names, not read back from the network: ARM's preflight check
// may not resolve run-time references, and Storage validates its network rules there.
var appsSubnetName = 'snet-apps'
var postgresSubnetName = 'snet-postgres'
var appsSubnetId = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, appsSubnetName)
var postgresSubnetId = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, postgresSubnetName)

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'vnet-agentcore-${environmentName}'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.40.0.0/16'] }
    subnets: [
      {
        name: appsSubnetName
        properties: {
          addressPrefix: '10.40.0.0/23'
          // Storage only accepts traffic from this subnet.
          serviceEndpoints: [{ service: 'Microsoft.Storage' }]
          delegations: [{ name: 'apps', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: postgresSubnetName
        properties: {
          addressPrefix: '10.40.2.0/24'
          delegations: [{ name: 'postgres', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }]
        }
      }
    ]
  }
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    location: location
    tags: tags
    serverName: postgresServerName
    skuName: postgresSku
    subnetId: postgresSubnetId
    vnetId: vnet.id
    administratorLogin: 'agentcoreadmin'
    administratorPassword: keyVault.getSecret('pg-admin-password')
    backupRetentionDays: postgresBackupDays
    geoRedundantBackup: postgresGeoBackup
  }
}

// Blob Storage: no public blobs and no shared keys; the app uses its managed identity.
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'stagentcore${environmentName}${suffix}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    // Only the apps' subnet can reach it; there is no access from the internet.
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
      virtualNetworkRules: [{ id: appsSubnetId, action: 'Allow' }]
    }
  }
}

// Deleted or overwritten documents and reports can be got back for blobRestoreDays:
// soft delete for blobs and containers, versions, and point-in-time restore (which needs
// the change feed, and a delete retention longer than the restore window).
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    isVersioningEnabled: true
    changeFeed: { enabled: true, retentionInDays: blobRestoreDays + 1 }
    deleteRetentionPolicy: { enabled: true, days: blobRestoreDays + 1 }
    containerDeleteRetentionPolicy: { enabled: true, days: blobRestoreDays + 1 }
    restorePolicy: { enabled: true, days: blobRestoreDays }
  }
}

// The audit log's write-once copy (task 14): a separate account, one container with a
// time-based retention policy that allows appends only. Within auditRetentionDays nothing
// written can be changed or deleted, by the app or by an account owner. The policy is
// left unlocked here; locking it is a deliberate, one-way step (docs/operations.md).
resource auditStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'staudit${environmentName}${suffix}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
      virtualNetworkRules: [{ id: appsSubnetId, action: 'Allow' }]
    }
  }
}

resource auditBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: auditStorage
  name: 'default'
}

resource auditContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: auditBlobService
  name: 'audit'
  properties: { publicAccess: 'None' }
}

resource auditImmutability 'Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies@2023-05-01' = if (!auditPolicyLocked) {
  parent: auditContainer
  name: 'default'
  properties: {
    immutabilityPeriodSinceCreationInDays: auditRetentionDays
    // Append blobs may still be added to; nothing already written can change.
    allowProtectedAppendWrites: true
  }
}

// The worker alone writes the audit copy (review S7); the web app has no access to it.
// The retention policy stops it changing or deleting anything younger than
// auditRetentionDays; an older copy it could delete (a custom read-and-add role, under
// Later in docs/PLAN.md, would stop that).
resource workerAuditAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(auditStorage.id, workerIdentity.id, storageBlobDataContributor)
  scope: auditStorage
  properties: {
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributor)
  }
}

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    location: location
    tags: tags
    environmentName: environmentName
    logAnalyticsWorkspaceId: logs.id
    webAppName: webAppName
    workerAppName: workerAppName
    postgresServerId: postgres.outputs.id
    alertEmail: alertEmail
  }
}

resource appBlobAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, appIdentity.id, storageBlobDataContributor)
  scope: storage
  properties: {
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributor)
  }
}

// The worker reads documents and writes reports and texts.
resource workerBlobAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, workerIdentity.id, storageBlobDataContributor)
  scope: storage
  properties: {
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributor)
  }
}

module email 'modules/email.bicep' = {
  name: 'email'
  params: {
    tags: tags
    environmentName: environmentName
    suffix: suffix
    keyVaultName: keyVaultName
    appPrincipalId: appIdentity.properties.principalId
  }
}

resource appsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-agentcore-${environmentName}'
  location: location
  tags: tags
  properties: {
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    vnetConfiguration: { infrastructureSubnetId: appsSubnetId, internal: false }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

var identity = { type: 'UserAssigned', userAssignedIdentities: { '${appIdentity.id}': {} } }
var registries = [{ server: registryLoginServer, identity: appIdentity.id }]
var opsIdentityConfig = { type: 'UserAssigned', userAssignedIdentities: { '${opsIdentity.id}': {} } }
var opsRegistries = [{ server: registryLoginServer, identity: opsIdentity.id }]
var vaultUri = keyVault.properties.vaultUri
func kvSecret(name string, vault string, identityId string) object => {
  name: name
  keyVaultUrl: '${vault}secrets/${name}'
  identity: identityId
}

module openai 'modules/openai.bicep' = if (azureOpenAiEnabled) {
  name: 'openai'
  params: {
    location: location
    tags: tags
    accountName: 'oai-agentcore-${environmentName}-${suffix}'
    modelName: azureOpenAiModel
    modelVersion: azureOpenAiModelVersion
    capacity: azureOpenAiCapacity
    principalId: workerIdentity.properties.principalId // only the worker calls models
  }
}

// The worker's model settings (packages/core/src/models/settings.ts); none while off.
var modelEnv = azureOpenAiEnabled
  ? [
      { name: 'MODEL_PROVIDER', value: 'azure-openai' }
      { name: 'AZURE_OPENAI_ENDPOINT', value: openai!.outputs.endpoint }
      { name: 'AZURE_OPENAI_DEPLOYMENT', value: openai!.outputs.deploymentName }
      { name: 'AZURE_OPENAI_MODEL', value: azureOpenAiModel }
    ]
  : []

var temporalEnv = [
  { name: 'TEMPORAL_ADDRESS', value: temporalAddress }
  { name: 'TEMPORAL_NAMESPACE', value: temporalNamespace }
  { name: 'TEMPORAL_API_KEY', secretRef: 'temporal-api-key' }
  { name: 'JOB_TASK_QUEUE', value: 'documents' }
]
var entraEnabled = !empty(entraClientId)
var googleEnabled = !empty(googleClientId)

resource web 'Microsoft.App/containerApps@2024-03-01' = if (deployApps) {
  name: webAppName
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: appsEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      ingress: { external: true, targetPort: 3000, transport: 'auto', allowInsecure: false }
      registries: registries
      secrets: concat(
        [
          kvSecret('database-url', vaultUri, appIdentity.id)
          kvSecret('tenant-context-key', vaultUri, appIdentity.id)
          kvSecret('auth-secret', vaultUri, appIdentity.id)
          kvSecret('acs-connection-string', vaultUri, appIdentity.id)
          kvSecret('temporal-api-key', vaultUri, appIdentity.id)
        ],
        entraEnabled ? [kvSecret('entra-client-secret', vaultUri, appIdentity.id)] : [],
        googleEnabled ? [kvSecret('google-client-secret', vaultUri, appIdentity.id)] : []
      )
    }
    template: {
      containers: [
        {
          name: 'web'
          image: '${registryLoginServer}/agentcore-web:${imageTag}'
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(
            [
              { name: 'DATABASE_URL', secretRef: 'database-url' }
              { name: 'TENANT_CONTEXT_KEY', secretRef: 'tenant-context-key' }
              { name: 'AUTH_SECRET', secretRef: 'auth-secret' }
              { name: 'AUTH_URL', value: 'https://${webAppName}.${appsEnvironment.properties.defaultDomain}' }
              { name: 'AZURE_STORAGE_ACCOUNT_URL', value: storage.properties.primaryEndpoints.blob }
              { name: 'AZURE_CLIENT_ID', value: appIdentity.properties.clientId }
              { name: 'EMAIL_TRANSPORT', value: 'acs' }
              { name: 'ACS_CONNECTION_STRING', secretRef: 'acs-connection-string' }
              { name: 'EMAIL_FROM', value: email.outputs.senderAddress }
              { name: 'MAX_UPLOAD_MB', value: '25' }
              { name: 'MAX_UPLOADS_PER_TENANT_PER_DAY', value: '500' }
              { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: monitoring.outputs.appInsightsConnectionString }
              { name: 'OPERATOR_ENTRA_TENANT_ID', value: operatorEntraTenantId }
            ],
            temporalEnv,
            entraEnabled
              ? [
                  { name: 'AUTH_MICROSOFT_ENTRA_ID_ID', value: entraClientId }
                  { name: 'AUTH_MICROSOFT_ENTRA_ID_SECRET', secretRef: 'entra-client-secret' }
                ]
              : [],
            googleEnabled
              ? [
                  { name: 'AUTH_GOOGLE_ID', value: googleClientId }
                  { name: 'AUTH_GOOGLE_SECRET', secretRef: 'google-client-secret' }
                ]
              : []
          )
          // Probes use /api/health (no database), so a database blip does not restart
          // the app; the deploy checks /api/ready, which queries it.
          probes: [
            { type: 'Readiness', httpGet: { path: '/api/health', port: 3000 }, periodSeconds: 10 }
            { type: 'Liveness', httpGet: { path: '/api/health', port: 3000 }, periodSeconds: 30 }
          ]
        }
      ]
      // Scales to zero when idle; the first request after a quiet spell waits a few
      // seconds while it starts.
      scale: {
        minReplicas: 0
        maxReplicas: 2
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '50' } } }]
      }
    }
  }
  dependsOn: [appSecretAccess]
}

resource worker 'Microsoft.App/containerApps@2024-03-01' = if (deployApps) {
  name: workerAppName
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${workerIdentity.id}': {} } }
  properties: {
    environmentId: appsEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      registries: [{ server: registryLoginServer, identity: workerIdentity.id }]
      secrets: [
        kvSecret('database-url', vaultUri, workerIdentity.id)
        kvSecret('tenant-context-key', vaultUri, workerIdentity.id)
        kvSecret('temporal-api-key', vaultUri, workerIdentity.id)
      ]
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: '${registryLoginServer}/agentcore-worker:${imageTag}'
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(
            [
              { name: 'DATABASE_URL', secretRef: 'database-url' }
              { name: 'TENANT_CONTEXT_KEY', secretRef: 'tenant-context-key' }
              // Reads documents and writes reports with its own managed identity.
              { name: 'AZURE_STORAGE_ACCOUNT_URL', value: storage.properties.primaryEndpoints.blob }
              { name: 'AZURE_CLIENT_ID', value: workerIdentity.properties.clientId }
              // The audit log's write-once copy (apps/worker/src/audit-copy.ts).
              { name: 'AUDIT_STORAGE_ACCOUNT_URL', value: auditStorage.properties.primaryEndpoints.blob }
              { name: 'AUDIT_COPY_EPOCH', value: string(auditCopyEpoch) }
              { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: monitoring.outputs.appInsightsConnectionString }
            ],
            temporalEnv,
            modelEnv
          )
        }
      ]
      // Always one: the worker polls Temporal for jobs.
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
  dependsOn: [workerSecretAccess]
}

// Runs inside the network on each deploy: creates the database, applies migrations,
// sets the app role's login and the tenant context key (packages/db/src/deploy-cli.ts).
resource migrate 'Microsoft.App/jobs@2024-03-01' = {
  name: 'caj-agentcore-${environmentName}-migrate'
  location: location
  tags: tags
  identity: opsIdentityConfig
  properties: {
    environmentId: appsEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: opsRegistries
      secrets: [
        kvSecret('database-admin-url', vaultUri, opsIdentity.id)
        kvSecret('app-db-password', vaultUri, opsIdentity.id)
        kvSecret('tenant-context-key', vaultUri, opsIdentity.id)
      ]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: '${registryLoginServer}/agentcore-worker:${imageTag}'
          command: ['node', 'packages/db/src/deploy-cli.ts']
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'DATABASE_ADMIN_URL', secretRef: 'database-admin-url' }
            { name: 'APP_DB_PASSWORD', secretRef: 'app-db-password' }
            { name: 'TENANT_CONTEXT_KEY', secretRef: 'tenant-context-key' }
          ]
        }
      ]
    }
  }
  dependsOn: [postgres, opsSecretAccess]
}

// For one-off setup commands inside the network, as the app role (the database is
// private): packages/db/src/admin-cli.ts, chosen by ADMIN_COMMAND and ADMIN_ARGS (see
// infra/azure/README.md). Without them it only prints how to use it.
// infra/azure/README.md step 5 starts this job with its template overridden (az rest): keep
// its env, command and resources there in step with this.
resource admin 'Microsoft.App/jobs@2024-03-01' = {
  name: 'caj-agentcore-${environmentName}-admin'
  location: location
  tags: tags
  identity: opsIdentityConfig
  properties: {
    environmentId: appsEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 300
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: opsRegistries
      secrets: [
        kvSecret('database-url', vaultUri, opsIdentity.id)
        kvSecret('tenant-context-key', vaultUri, opsIdentity.id)
      ]
    }
    template: {
      containers: [
        {
          name: 'admin'
          image: '${registryLoginServer}/agentcore-worker:${imageTag}'
          command: ['node', 'packages/db/src/admin-cli.ts']
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'TENANT_CONTEXT_KEY', secretRef: 'tenant-context-key' }
          ]
        }
      ]
    }
  }
  dependsOn: [migrate]
}

// The restore drill's checks (task 14; .github/workflows/restore-drill.yml starts it with
// RESTORE_HOST and RESTORE_POINT, after restoring Postgres to a temporary server). It reads
// the live database's settings as the ops identity, and checks Blob Storage restores as
// the app identity, which has access to it.
resource restoreCheck 'Microsoft.App/jobs@2024-03-01' = {
  name: 'caj-agentcore-${environmentName}-restore-check'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${opsIdentity.id}': {}, '${appIdentity.id}': {} }
  }
  properties: {
    environmentId: appsEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 900
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: opsRegistries
      secrets: [
        kvSecret('database-admin-url', vaultUri, opsIdentity.id)
        kvSecret('database-url', vaultUri, opsIdentity.id)
        kvSecret('tenant-context-key', vaultUri, opsIdentity.id)
      ]
    }
    template: {
      containers: [
        {
          name: 'restore-check'
          image: '${registryLoginServer}/agentcore-worker:${imageTag}'
          command: ['node', 'apps/worker/src/restore-check-cli.ts']
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'DATABASE_ADMIN_URL', secretRef: 'database-admin-url' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'TENANT_CONTEXT_KEY', secretRef: 'tenant-context-key' }
            { name: 'AZURE_STORAGE_ACCOUNT_URL', value: storage.properties.primaryEndpoints.blob }
            { name: 'AZURE_CLIENT_ID', value: appIdentity.properties.clientId }
            // Set by the drill when it starts the job.
            { name: 'RESTORE_HOST', value: '' }
            { name: 'RESTORE_POINT', value: '' }
          ]
        }
      ]
    }
  }
  dependsOn: [migrate]
}

output webUrl string = 'https://${webAppName}.${appsEnvironment.properties.defaultDomain}'
output migrateJobName string = migrate.name
output adminJobName string = admin.name
output restoreCheckJobName string = restoreCheck.name
output postgresServerName string = postgresServerName
output webAppName string = webAppName
output workerAppName string = workerAppName
output postgresFqdn string = postgres.outputs.fqdn
output postgresServerId string = postgres.outputs.id
output storageAccountName string = storage.name
