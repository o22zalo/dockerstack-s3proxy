export async function checkBackendHealth(account) {
  const startedAt = Date.now()
  if (!account?.endpoint || !account?.bucket) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: 'missing endpoint/bucket config',
    }
  }

  return {
    ok: true,
    latencyMs: Date.now() - startedAt,
    error: null,
  }
}

export async function replaceBackendConfig(sourceAccountId, newAccountConfig, { dryRun = false } = {}) {
  return {
    migrationType: 'replace_config',
    sourceAccountId,
    dryRun,
    status: 'not_implemented',
    newAccountConfig,
  }
}

export async function migrateBackendObjects(sourceAccountId, targetAccountId, options = {}, logger = console) {
  logger.info?.({ sourceAccountId, targetAccountId, options }, 'migrate backend requested (stub)')
  return {
    migrationType: 'copy_objects',
    sourceAccountId,
    targetAccountId,
    status: 'not_implemented',
    options,
  }
}

export async function rollbackMigration(migrationId) {
  return {
    migrationId,
    status: 'not_implemented',
  }
}

export async function diagnoseBackend(accountId) {
  return {
    accountId,
    healthy: false,
    error: 'not_implemented',
    trackedObjects: 0,
    trackedBytes: 0,
    suggestedActions: ['replaceConfig', 'migrateToOtherAccount'],
    alternativeAccounts: [],
  }
}
