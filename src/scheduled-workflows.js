export async function runGroupedWorkflow({
  task,
  stage,
  groups,
  operation,
  notifyFailure = async () => {},
  logger = console,
}) {
  const results = [];
  for (const group of groups) {
    const scope = group.project || group.chatId;
    let alert;
    try {
      const result = await operation(group);
      results.push({ group: scope, ...result });
      if (result?.errors?.length) {
        alert = { task, scope, stage, errors: result.errors };
      }
    } catch (error) {
      results.push({ group: scope, failed: true, error });
      alert = {
        task,
        scope,
        stage: error.weeklyInstanceStage || stage,
        errors: [error],
      };
    }

    if (alert) {
      try {
        await notifyFailure(alert);
      } catch {
        try {
          logger.warn('[scheduled-workflows] failure notification failed');
        } catch {}
      }
    }
  }
  return results;
}
