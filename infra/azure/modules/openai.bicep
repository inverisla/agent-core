// Azure OpenAI (task 8): one account and one model deployment, of the Data Zone Standard
// (EU) type, so prompts and answers are processed only in the EU. Key authentication is
// off: the worker signs in with its managed identity, which gets the OpenAI User role.
param location string
param tags object
param accountName string
param modelName string
param modelVersion string
@description('Thousands of tokens per minute.')
param capacity int
@description('The identity that calls the model: the worker\'s.')
param principalId string

// Cognitive Services OpenAI User: call the deployments, nothing else.
var openAiUser = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: accountName
  location: location
  tags: tags
  kind: 'OpenAI'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: accountName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource deployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: account
  name: modelName
  sku: { name: 'DataZoneStandard', capacity: capacity }
  properties: {
    model: { format: 'OpenAI', name: modelName, version: modelVersion }
  }
}

resource workerAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, principalId, openAiUser)
  scope: account
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', openAiUser)
  }
}

output endpoint string = account.properties.endpoint
output deploymentName string = deployment.name
