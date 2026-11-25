// Stage 1 of the dev environment: what must exist before images are pushed and secrets
// generated. Deployed into the resource group by .github/workflows/deploy.yml.
targetScope = 'resourceGroup'

@description('Azure region; must be in the UK or EU. Set by the AZURE_LOCATION variable on the GitHub dev environment.')
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

@description('Environment name, used in resource names.')
param environmentName string = 'dev'

@description('Object ID of the GitHub Actions deploy identity, which writes secrets and pushes images.')
param deployPrincipalId string

// The region is part of the suffix, so moving region gives new names instead of clashing
// with the soft-deleted Key Vault and Log Analytics workspace of the old region.
var suffix = substring(uniqueString(resourceGroup().id, location), 0, 6)
var tags = { project: 'agent-core', env: environmentName }

// Built-in role IDs.
var roles = {
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  acrPush: '8311e382-0749-4cb8-b61a-304f252e45ec'
}

// The identity the web app runs as: only the secrets it needs (granted per secret in
// main.bicep), never the database admin credentials, and no access to the audit copy.
resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-agentcore-${environmentName}-app'
  location: location
  tags: tags
}

// The identity the worker runs as (review S7): its own secrets, the documents, the model,
// and the only identity that may write the audit log's write-once copy.
resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-agentcore-${environmentName}-worker'
  location: location
  tags: tags
}

// The identity the migrate and admin jobs run as: the database admin secrets.
resource opsIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-agentcore-${environmentName}-ops'
  location: location
  tags: tags
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-agentcore-${environmentName}-${suffix}'
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    // main.bicep reads the Postgres admin password with getSecret, which ARM only
    // allows from vaults enabled for template deployment.
    enabledForTemplateDeployment: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    publicNetworkAccess: 'Enabled'
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'acragentcore${environmentName}${suffix}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource deploySecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, deployPrincipalId, roles.keyVaultSecretsOfficer)
  scope: keyVault
  properties: {
    principalId: deployPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsOfficer)
  }
}

resource deployAcrPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, deployPrincipalId, roles.acrPush)
  scope: registry
  properties: {
    principalId: deployPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPush)
  }
}

resource appAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, appIdentity.id, roles.acrPull)
  scope: registry
  properties: {
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
  }
}

resource workerAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, workerIdentity.id, roles.acrPull)
  scope: registry
  properties: {
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
  }
}

resource opsAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, opsIdentity.id, roles.acrPull)
  scope: registry
  properties: {
    principalId: opsIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
  }
}

output keyVaultName string = keyVault.name
output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
output appIdentityName string = appIdentity.name
output opsIdentityName string = opsIdentity.name
output workerIdentityName string = workerIdentity.name
@description('Name suffix; main.bicep takes it from here so both stages always agree.')
output nameSuffix string = suffix
output postgresServerName string = 'pg-agentcore-${environmentName}-${suffix}'
