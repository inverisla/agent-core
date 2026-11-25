// PostgreSQL Flexible Server, reachable only inside the virtual network.
param location string
param tags object
param serverName string
@description('Compute size. The tier follows from it: B is Burstable, D General Purpose, E Memory Optimized.')
param skuName string
param subnetId string
param vnetId string
param administratorLogin string
@secure()
param administratorPassword string
@description('Days of point-in-time backups (7 to 35).')
@minValue(7)
@maxValue(35)
param backupRetentionDays int = 7
@description('Also keep backups in the paired region. Only in a region whose pair stays in the UK or EU (UK South and UK West, for example).')
param geoRedundantBackup bool = false

resource dnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: '${serverName}.private.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

resource dnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: dnsZone
  name: 'vnet'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnetId }
  }
}

var tier = startsWith(skuName, 'Standard_B')
  ? 'Burstable'
  : startsWith(skuName, 'Standard_E') ? 'MemoryOptimized' : 'GeneralPurpose'

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: serverName
  location: location
  tags: tags
  sku: { name: skuName, tier: tier }
  properties: {
    version: '17'
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    authConfig: { passwordAuth: 'Enabled', activeDirectoryAuth: 'Disabled' }
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackup ? 'Enabled' : 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
    network: {
      delegatedSubnetResourceId: subnetId
      privateDnsZoneArmResourceId: dnsZone.id
      publicNetworkAccess: 'Disabled'
    }
  }
  dependsOn: [dnsLink]
}

// The migrations need pgcrypto (HMAC for the signed tenant context).
resource extensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'azure.extensions'
  properties: { value: 'PGCRYPTO', source: 'user-override' }
}

output fqdn string = server.properties.fullyQualifiedDomainName
output id string = server.id
