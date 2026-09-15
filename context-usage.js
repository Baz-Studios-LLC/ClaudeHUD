function latestContext(message, previous = null) {
  const usage = message?.usage;
  if (!usage || !Number.isFinite(usage.input_tokens) || usage.input_tokens < 0) return previous;
  const fields = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
  if (fields.some(key => usage[key] != null && (!Number.isFinite(usage[key]) || usage[key] < 0))) return previous;
  return { used: fields.reduce((sum, key) => sum + (usage[key] || 0), 0), model: message.model,
    limit: previous?.model === message.model ? previous.limit : null };
}
function withContextLimit(context, modelUsage) {
  if (!context) return null;
  const usage = modelUsage?.[context.model] || Object.values(modelUsage || {}).find(value => value.canonicalModel === context.model);
  return usage?.contextWindow > 0 ? { ...context, limit: usage.contextWindow } : context;
}
module.exports = { latestContext, withContextLimit };
