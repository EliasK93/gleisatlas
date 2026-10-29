// Gleisatlas on Azure, deployed at resource-group scope in two phases (docs/deployment.md §4):
// phase 1 without `image` creates everything except the Container App, so the image and the data
// exist before the app starts; phase 2 passes `image` and adds the app.

@description('Receives the budget alerts. Never stored in the repository.')
param budgetEmail string

@description('First day of the month of the first deployment, e.g. 2026-11-01. Azure does not let a budget\'s start date change, so pass the same value on every later deployment.')
param budgetStartDate string

@description('Monthly budget of the resource group, in the billing currency. Alerts fire at 50 % and 90 % actual and 100 % forecast.')
param budgetAmount int

@description('The API image, e.g. <registry>.azurecr.io/api:<tag>. Empty: no Container App (phase 1).')
param image string = ''

@description('vCPU of the API container (docs/deployment.md §3).')
param cpu string = '0.5'

@description('Memory of the API container; Container Apps pairs 0.5 vCPU with 1Gi.')
param memory string = '1Gi'

@description('Polars threads; matches the vCPU count, since Polars otherwise sees the host\'s cores.')
param polarsMaxThreads string = '1'

@description('Region of the Static Web App, which is offered in few regions, none of them open in Europe to new subscriptions; its files are served worldwide either way (docs/deployment.md §3).')
param webLocation string = 'eastus2'

var location = resourceGroup().location
var suffix = uniqueString(resourceGroup().id)
var acrPullRole = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)

resource logs 'Microsoft.OperationalInsights/workspaces@2026-03-01' = {
  name: 'gleisatlas-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: json('0.1') }
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2026-06-01' = {
  name: 'gleisatlas${suffix}'
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    // ponytail: public read of CC BY data, so the container needs no secret; a managed-identity token if a policy forbids it
    allowBlobPublicAccess: true
  }
}

resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2026-06-01' = {
  parent: storage
  name: 'default'
}

resource dataContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2026-06-01' = {
  parent: blobs
  name: 'data'
  properties: { publicAccess: 'Blob' } // read by URL, no listing
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' = {
  name: 'gleisatlas${suffix}'
  location: location
  sku: { name: 'Basic' }
  // Legacy mode keeps AcrPull working; the ABAC mode, announced as the future default, ignores it.
  properties: { adminUserEnabled: false, roleAssignmentMode: 'LegacyRegistryPermissions' }
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'gleisatlas-pull'
  location: location
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, pullIdentity.id, acrPullRole)
  properties: {
    roleDefinitionId: acrPullRole
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Consumption only: no workload profiles, zone redundancy, VNet or private endpoints, which bring
// the Dedicated plan's management charge (docs/deployment.md §3).
resource environment 'Microsoft.App/managedEnvironments@2026-07-01' = {
  name: 'gleisatlas-env'
  location: location
  properties: {
    environmentMode: 'ConsumptionOnly'
    zoneRedundant: false
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource web 'Microsoft.Web/staticSites@2025-03-01' = {
  name: 'gleisatlas-web'
  location: webLocation
  sku: { name: 'Free', tier: 'Free' }
  properties: {} // no repository: deployed by token with the SWA CLI
}

resource budget 'Microsoft.Consumption/budgets@2026-06-01' = {
  name: 'gleisatlas-budget'
  properties: {
    category: 'Cost'
    amount: budgetAmount
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStartDate }
    notifications: {
      actual50: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 50
        thresholdType: 'Actual'
        contactEmails: [budgetEmail]
      }
      actual90: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 90
        thresholdType: 'Actual'
        contactEmails: [budgetEmail]
      }
      forecast100: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: [budgetEmail]
      }
    }
  }
}

resource api 'Microsoft.App/containerApps@2026-07-01' = if (!empty(image)) {
  name: 'gleisatlas-api'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${pullIdentity.id}': {} }
  }
  dependsOn: [acrPull] // the first revision pulls the image
  properties: {
    environmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8000
        allowInsecure: false
      }
      registries: [{ server: registry.properties.loginServer, identity: pullIdentity.id }]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: image
          resources: { cpu: json(cpu), memory: memory }
          env: [
            { name: 'DATA_URL', value: '${storage.properties.primaryEndpoints.blob}${dataContainer.name}/' }
            { name: 'CORS_ORIGINS', value: 'https://${web.properties.defaultHostname}' }
            { name: 'POLARS_MAX_THREADS', value: polarsMaxThreads }
          ]
        }
      ]
      // One replica: the query cap and the caches are per process (docs/patterns.md §8). No rules:
      // the platform's default HTTP rule wakes the app from zero on a request.
      scale: {
        minReplicas: 0
        maxReplicas: 1
        cooldownPeriod: 120 // seconds without a request before the replica stops (default 300)
      }
    }
  }
}

output apiUrl string = empty(image) ? '' : 'https://${api!.properties.configuration.ingress.fqdn}'
output webName string = web.name
output webHostname string = web.properties.defaultHostname
output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output storageName string = storage.name
output workspaceId string = logs.properties.customerId
