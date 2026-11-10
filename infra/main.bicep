// Living Data API: dev hosting on Azure Container Apps (consumption plan).
// Deployed by .github/workflows/deploy-dev.yml into one resource group, by an identity
// that has Contributor on that group only. Creates no role assignments.
//
// Cost levers (see infra/README.md): minReplicas = 0 scales to zero when idle;
// Log Analytics has a daily cap; the registry is the Basic tier.

@description('Short environment name used in resource names.')
param envName string = 'dev'

param location string = resourceGroup().location

@description('Container image to run. The first deploy uses a public placeholder.')
param image string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('0 = scale to zero when idle (cold start of a few seconds). 1 = always on.')
@minValue(0)
@maxValue(1)
param minReplicas int = 0

@description('Entra object ID of the person who manages secrets in the vault (Elijah).')
param adminObjectId string

@description('Comma-separated front-end origins allowed by Clerk (azp claim).')
param clerkAuthorizedParties string = ''

@description('Set true once the vault holds database-url and clerk-secret-key. Until then the placeholder image runs without secrets.')
param secretsReady bool = false

@description('Sending address on a domain verified in SendGrid, e.g. reminders@mail.living-data.com. Empty = email off.')
param emailFromAddress string = ''

@description('Front-end origin serving the customer pages /r and /unsubscribe, e.g. https://app.replit.app.')
param publicAppUrl string = ''

@description('Set true once the vault holds sendgrid-api-key. Until then campaigns can be drafted and previewed but not sent.')
param sendgridReady bool = false

var suffix = uniqueString(resourceGroup().id)
var tags = { app: 'ldhp-api', env: envName }

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-ldhp-${envName}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    // Hard cap so a log storm can't run up a bill. 0.15 GB/day ~ 4.5 GB/month.
    workspaceCapping: { dailyQuotaGb: json('0.15') }
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'crldhp${envName}${suffix}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    // Admin credentials let the app pull without a role assignment (the deploy identity
    // can't create those). Scoped to this one registry.
    adminUserEnabled: true
  }
}

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-ldhp-${envName}'
  location: location
  tags: tags
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-ldhp-${envName}-${take(suffix, 8)}'
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: false
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    accessPolicies: [
      {
        // The running API: read secrets only.
        tenantId: tenant().tenantId
        objectId: appIdentity.properties.principalId
        permissions: { secrets: ['get', 'list'] }
      }
      {
        // The deploy workflow: reads the migration URL to run migrations.
        tenantId: tenant().tenantId
        objectId: deployer().objectId
        permissions: { secrets: ['get', 'list'] }
      }
      {
        // The owner adds and rotates secrets in the portal.
        tenantId: tenant().tenantId
        objectId: adminObjectId
        permissions: { secrets: ['get', 'list', 'set', 'delete', 'recover'] }
      }
    ]
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-ldhp-${envName}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

var appSecrets = secretsReady
  ? [
      { name: 'database-url', keyVaultUrl: '${vault.properties.vaultUri}secrets/database-url', identity: appIdentity.id }
      { name: 'clerk-secret-key', keyVaultUrl: '${vault.properties.vaultUri}secrets/clerk-secret-key', identity: appIdentity.id }
    ]
  : []

var emailSecrets = secretsReady && sendgridReady
  ? [{ name: 'sendgrid-api-key', keyVaultUrl: '${vault.properties.vaultUri}secrets/sendgrid-api-key', identity: appIdentity.id }]
  : []

var appEnv = secretsReady
  ? [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'LOG_LEVEL', value: 'info' }
      { name: 'DATABASE_URL', secretRef: 'database-url' }
      { name: 'CLERK_SECRET_KEY', secretRef: 'clerk-secret-key' }
      { name: 'CLERK_AUTHORIZED_PARTIES', value: clerkAuthorizedParties }
      { name: 'PUBLIC_BASE_URL', value: 'https://ca-ldhp-${envName}.${env.properties.defaultDomain}' }
    ]
  : []

var emailEnv = concat(
  secretsReady && sendgridReady ? [{ name: 'SENDGRID_API_KEY', secretRef: 'sendgrid-api-key' }] : [],
  secretsReady && !empty(emailFromAddress) ? [{ name: 'EMAIL_FROM_ADDRESS', value: emailFromAddress }] : [],
  secretsReady && !empty(publicAppUrl) ? [{ name: 'PUBLIC_APP_URL', value: publicAppUrl }] : []
)

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-ldhp-${envName}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${appIdentity.id}': {} }
  }
  properties: {
    environmentId: env.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: secretsReady ? 3000 : 80
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registry.properties.loginServer
          username: registry.listCredentials().username
          passwordSecretRef: 'registry-password'
        }
      ]
      secrets: concat(
        [{ name: 'registry-password', value: registry.listCredentials().passwords[0].value }],
        appSecrets,
        emailSecrets
      )
    }
    template: {
      containers: [
        {
          name: 'api'
          image: image
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: concat(appEnv, emailEnv)
          probes: secretsReady
            ? [
                { type: 'Liveness', httpGet: { path: '/v1/health', port: 3000 }, periodSeconds: 30 }
                { type: 'Readiness', httpGet: { path: '/v1/health', port: 3000 }, periodSeconds: 10 }
              ]
            : []
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: 2
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '50' } } }]
      }
    }
  }
}

output apiUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output vaultName string = vault.name
