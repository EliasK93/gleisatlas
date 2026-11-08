// Gleisatlas on Azure, deployed at resource-group scope in two phases (docs/deployment.md §4):
// phase 1 without `image` creates everything except the Container App and the collector job, so the
// data exists before the app starts; phase 2 passes `image` and adds them.

@description('Receives the budget alerts. Never stored in the repository.')
param budgetEmail string

@description('First day of the month of the first deployment, e.g. 2026-11-01. Azure does not let a budget\'s start date change, so pass the same value on every later deployment.')
param budgetStartDate string

@description('Monthly budget of the resource group, in the billing currency. Alerts fire at 50 % and 90 % actual and 100 % forecast.')
param budgetAmount int

@description('The API image, ghcr.io/<owner>/gleisatlas-api:<commit>, public so Azure pulls it without credentials. Empty: no Container App (phase 1).')
param image string = ''

@description('vCPU of the API container (docs/deployment.md §3).')
param cpu string = '1'

@description('Memory of the API container; Container Apps pairs 1 vCPU with 2Gi.')
param memory string = '2Gi'

@description('Polars threads; matches the vCPU count, since Polars otherwise sees the host\'s cores.')
param polarsMaxThreads string = '1'

@description('Region of the Static Web App, which is offered in few regions, none of them open in Europe to new subscriptions; its files are served worldwide either way (docs/deployment.md §3).')
param webLocation string = 'eastus2'

@secure()
@description('Client ID of the DB API Marketplace application, for the collector job. Empty: no job.')
param dbClientId string = ''

@secure()
@description('API key of the DB API Marketplace application, for the collector job. Empty: no job.')
param dbApiKey string = ''

var location = resourceGroup().location
var suffix = uniqueString(resourceGroup().id)
var blobContributorRole = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe' // Storage Blob Data Contributor
)
// The collector job comes with the API's image and only when the DB key is given.
var withJob = !empty(image) && !empty(dbClientId) && !empty(dbApiKey)
// The API reads its files from here, the job reads and writes its own files here.
var dataUrl = '${storage.properties.primaryEndpoints.blob}${dataContainer.name}/'

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
  properties: {
    environmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8000
        allowInsecure: false
      }
    }
    template: {
      containers: [
        {
          name: 'api'
          image: image
          resources: { cpu: json(cpu), memory: memory }
          env: [
            { name: 'DATA_URL', value: dataUrl }
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
        cooldownPeriod: 600 // seconds without a request before the replica stops (default 300)
      }
    }
  }
}

// The collector (pipeline/live.py) every 15 minutes: its own identity may write to the data
// container only (docs/deployment.md §3).
resource jobIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = if (withJob) {
  name: 'gleisatlas-job'
  location: location
}

resource jobWrite 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (withJob) {
  scope: dataContainer
  name: guid(dataContainer.id, jobIdentity.id, blobContributorRole)
  properties: {
    roleDefinitionId: blobContributorRole
    principalId: jobIdentity!.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource collector 'Microsoft.App/jobs@2026-07-01' = if (withJob) {
  name: 'gleisatlas-collector'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${jobIdentity.id}': {} }
  }
  dependsOn: [jobWrite] // the first execution writes blobs
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: { cronExpression: '*/15 * * * *', parallelism: 1, replicaCompletionCount: 1 }
      replicaTimeout: 840 // seconds: the run's 12-minute request deadline plus the blob sync
      replicaRetryLimit: 0 // the next execution 15 minutes later is the retry
      secrets: [
        { name: 'db-client-id', value: dbClientId }
        { name: 'db-api-key', value: dbApiKey }
      ]
    }
    template: {
      containers: [
        {
          name: 'collector'
          image: image
          command: ['python', '-m', 'pipeline.live']
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'DB_CLIENT_ID', secretRef: 'db-client-id' }
            { name: 'DB_API_KEY', secretRef: 'db-api-key' }
            { name: 'DATA_URL', value: dataUrl }
            { name: 'AZURE_CLIENT_ID', value: jobIdentity!.properties.clientId }
            { name: 'POLARS_MAX_THREADS', value: '1' }
          ]
        }
      ]
    }
  }
}

output apiUrl string = empty(image) ? '' : 'https://${api!.properties.configuration.ingress.fqdn}'
output webName string = web.name
output webHostname string = web.properties.defaultHostname
output storageName string = storage.name
