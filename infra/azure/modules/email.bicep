// Azure Communication Services Email with an Azure-managed sender domain, data kept in
// the UK. Its connection string goes straight into Key Vault.
param tags object
param environmentName string
param suffix string
param keyVaultName string
@description('The app identity, which may read the connection string.')
param appPrincipalId string

resource emailService 'Microsoft.Communication/emailServices@2023-04-01' = {
  name: 'email-agentcore-${environmentName}-${suffix}'
  location: 'global'
  tags: tags
  properties: { dataLocation: 'UK' }
}

resource domain 'Microsoft.Communication/emailServices/domains@2023-04-01' = {
  parent: emailService
  name: 'AzureManagedDomain'
  location: 'global'
  tags: tags
  properties: { domainManagement: 'AzureManaged', userEngagementTracking: 'Disabled' }
}

resource communication 'Microsoft.Communication/communicationServices@2023-04-01' = {
  name: 'acs-agentcore-${environmentName}-${suffix}'
  location: 'global'
  tags: tags
  properties: { dataLocation: 'UK', linkedDomains: [domain.id] }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource connectionSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'acs-connection-string'
  properties: { value: communication.listKeys().primaryConnectionString }
}

resource appReadsConnection 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(connectionSecret.id, appPrincipalId, '4633458b-17de-408a-b874-0445c86b69e6')
  scope: connectionSecret
  properties: {
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

output senderAddress string = 'DoNotReply@${domain.properties.mailFromSenderDomain}'
