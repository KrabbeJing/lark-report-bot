export async function runGroupedWorkflow({
  task,
  stage,
  groups,
  operation,
  notifyFailure = async () => {},
}) {
  const results = [];
  for (const group of groups) {
    const scope = group.project || group.chatId;
    try {
      const result = await operation(group);
      results.push({ group: scope, ...result });
      if (result?.errors?.length) {
        await notifyFailure({ task, scope, stage, errors: result.errors });
      }
    } catch (error) {
      results.push({ group: scope, failed: true, error });
      await notifyFailure({
        task,
        scope,
        stage: error.weeklyInstanceStage || stage,
        errors: [error],
      });
    }
  }
  return results;
}
