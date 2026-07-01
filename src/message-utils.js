export function getMessageText(message) {
  if (!message || message.message_type !== 'text') return '';
  try {
    return JSON.parse(message.content).text || '';
  } catch {
    return '';
  }
}

export function getSenderOpenId(eventData) {
  return eventData?.sender?.sender_id?.open_id || '';
}

export function isMentionedBot(message, botNames = ['数金小助手']) {
  const text = getMessageText(message);
  if (message?.mentions?.some(mention => {
    const name = mention.name || '';
    return mention.mentioned_type === 'bot' || botNames.some(botName => name.includes(botName));
  })) {
    return true;
  }
  return botNames.some(botName => text.includes(`@${botName}`) || text.includes(botName));
}

export function stripBotMentions(text, botNames = ['数金小助手']) {
  let result = String(text || '');
  for (const name of botNames) {
    result = result.replace(new RegExp(`@?${escapeRegExp(name)}\\s*`, 'g'), '');
  }
  return result.replace(/<at[^>]*>.*?<\/at>/g, '').trim();
}

export function isWeeklyCommand(text, message, botNames = ['数金小助手']) {
  const mentioned = isMentionedBot(message, botNames);
  if (!mentioned) return false;
  const command = stripBotMentions(text, botNames).replace(/\s+/g, '');
  return /^(周报|生成周报|本周周报|汇总周报|项目周报)$/.test(command);
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
