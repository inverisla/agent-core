// Monitoring and alerts (task 14). Application Insights takes the apps' traces and
// metrics; the alert rules read the apps' event lines (packages/core/src/telemetry.ts)
// from the Container Apps console logs in Log Analytics, so they work even if telemetry
// is misconfigured. Alerts email one address, given by the ALERT_EMAIL variable.

param location string
param tags object
param environmentName string
param logAnalyticsWorkspaceId string
param webAppName string
param workerAppName string
param postgresServerId string
@description('Where alerts go. Empty: the rules exist and fire, but nobody is emailed.')
param alertEmail string
@description('Postgres connections that alert: about 90% of what the server size lets the apps use. The default size, Standard_B1ms, allows 50 with 15 kept for Azure, so 35 for the apps; two web replicas and the worker can open 30 between them when busy.')
param postgresConnectionAlert int = 32

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-agentcore-${environmentName}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalyticsWorkspaceId
    // Sign-in with Entra is not needed for the SDK; the connection string is only for sending.
    DisableLocalAuth: false
    IngestionMode: 'LogAnalytics'
  }
}

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = if (!empty(alertEmail)) {
  name: 'ag-agentcore-${environmentName}'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'agentcore'
    enabled: true
    emailReceivers: [{ name: 'operators', emailAddress: alertEmail, useCommonAlertSchema: true }]
  }
}

var actions = empty(alertEmail) ? [] : [actionGroup.id]

// One app's event lines (JSON objects, packages/core/src/telemetry.ts) with this event
// name, matched exactly. The names are checked against the code by
// packages/core/src/telemetry-alerts.test.ts.
func eventQuery(app string, event string) string =>
  'ContainerAppConsoleLogs_CL | where ContainerAppName_s == "${app}" | where Log_s startswith "{" | extend e = parse_json(Log_s) | where tostring(e.event) == "${event}"'

var logRules = [
  {
    name: 'job-failed'
    description: 'A job ended failed after its retries. Its jobId, agent and reason code are in the log line.'
    severity: 1
    // One alert per failed job, named in the email, even while another is still open.
    query: '${eventQuery(workerAppName, 'job.failed')} | extend jobId = tostring(e.jobId)'
    operator: 'GreaterThan'
    threshold: 0
    window: 'PT5M'
    dimensions: [{ name: 'jobId', operator: 'Include', values: ['*'] }]
  }
  {
    name: 'audit-copy-failed'
    description: 'The audit log could not be copied to write-once storage.'
    severity: 1
    query: eventQuery(workerAppName, 'audit.copy-failed')
    operator: 'GreaterThan'
    threshold: 0
    window: 'PT15M'
    dimensions: []
  }
  {
    name: 'web-errors'
    description: 'More than 5 unhandled errors in the web app in 15 minutes.'
    severity: 2
    query: eventQuery(webAppName, 'app.error')
    operator: 'GreaterThan'
    threshold: 5
    window: 'PT15M'
    dimensions: []
  }
  {
    name: 'worker-silent'
    description: 'The worker has not reported in for 15 minutes: jobs are not being run.'
    severity: 1
    query: '${eventQuery(workerAppName, 'worker.heartbeat')} or tostring(e.event) == "worker.started"'
    operator: 'LessThan'
    threshold: 1
    window: 'PT15M'
    dimensions: []
  }
  {
    name: 'sign-in-refusals'
    description: 'More than 50 refused sign-ins in an hour: someone may be trying addresses or links.'
    severity: 2
    query: eventQuery(webAppName, 'sign-in.refused')
    operator: 'GreaterThan'
    threshold: 50
    window: 'PT1H'
    dimensions: []
  }
  {
    name: 'job-stuck'
    description: 'A job could not be started, or a review decision could not reach its job, after several minutes (the job sweep keeps trying every 5 minutes). Its jobId and reason are in the log line.'
    severity: 2
    query: '${eventQuery(workerAppName, 'job.stuck')} or tostring(e.event) == "job.decision-undelivered"'
    operator: 'GreaterThan'
    threshold: 0
    window: 'PT15M'
    dimensions: []
  }
  {
    name: 'upload-failed'
    description: 'Uploads are failing: more than 3 in 15 minutes could not be stored (storage or the database). The tenant ID and error name are in the log lines.'
    severity: 2
    query: eventQuery(webAppName, 'upload.failed')
    operator: 'GreaterThan'
    threshold: 3
    window: 'PT15M'
    dimensions: []
  }
  {
    name: 'email-failed'
    description: 'A sign-in or welcome email could not be sent. People asking for links are getting nothing.'
    severity: 2
    query: eventQuery(webAppName, 'email.failed')
    operator: 'GreaterThan'
    threshold: 0
    window: 'PT15M'
    dimensions: []
  }
]

resource logAlerts 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = [
  for rule in logRules: {
    name: 'alert-agentcore-${environmentName}-${rule.name}'
    location: location
    tags: tags
    properties: {
      displayName: 'Agent core ${environmentName}: ${rule.name}'
      description: rule.description
      severity: rule.severity
      enabled: true
      scopes: [logAnalyticsWorkspaceId]
      evaluationFrequency: 'PT5M'
      windowSize: rule.window
      // The table only exists once the apps have logged something.
      skipQueryValidation: true
      autoMitigate: true
      criteria: {
        allOf: [
          {
            query: rule.query
            timeAggregation: 'Count'
            operator: rule.operator
            threshold: rule.threshold
            failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
            dimensions: rule.dimensions
          }
        ]
      }
      actions: { actionGroups: actions }
    }
  }
]

var postgresRules = [
  {
    name: 'postgres-storage'
    description: 'Postgres storage is over 80% full.'
    metric: 'storage_percent'
    threshold: 80
    aggregation: 'Maximum'
    window: 'PT1H'
  }
  {
    name: 'postgres-cpu'
    description: 'Postgres CPU has averaged over 80% for 30 minutes: the server may need a larger size (POSTGRES_SKU).'
    metric: 'cpu_percent'
    threshold: 80
    aggregation: 'Average'
    window: 'PT30M'
  }
  {
    // The apps use up to 10 each per replica (packages/db/src/tenant-context.ts).
    name: 'postgres-connections'
    description: 'Postgres has had over ${postgresConnectionAlert} connections open: close to what the server size allows the apps.'
    metric: 'active_connections'
    threshold: postgresConnectionAlert
    aggregation: 'Maximum'
    window: 'PT15M'
  }
]

resource postgresAlerts 'Microsoft.Insights/metricAlerts@2018-03-01' = [
  for rule in postgresRules: {
    name: 'alert-agentcore-${environmentName}-${rule.name}'
    location: 'global'
    tags: tags
    properties: {
      description: rule.description
      severity: 2
      enabled: true
      scopes: [postgresServerId]
      evaluationFrequency: 'PT15M'
      windowSize: rule.window
      criteria: {
        'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
        allOf: [
          {
            criterionType: 'StaticThresholdCriterion'
            name: rule.metric
            metricName: rule.metric
            metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
            operator: 'GreaterThan'
            threshold: rule.threshold
            timeAggregation: rule.aggregation
          }
        ]
      }
      actions: [for id in actions: { actionGroupId: id }]
    }
  }
]

output appInsightsConnectionString string = appInsights.properties.ConnectionString
