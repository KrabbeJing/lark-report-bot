const MATCHED_STATUSES = new Set(['已匹配', '姓名匹配']);

const EMPTY_SNAPSHOT = Object.freeze({
  reporterNameText: '',
  memberOpenId: '',
  agileGroup: '',
  supervisor: '',
  supervisorOpenId: '',
  divisionalLeader: '',
  divisionalLeaderOpenId: '',
  matchingStatus: '未匹配',
  matchMethod: '',
});

export function isMatchedOrganizationStatus(status) {
  return MATCHED_STATUSES.has(String(status || '').trim());
}

export function snapshotFromContact(contact) {
  if (!contact) return { ...EMPTY_SNAPSHOT };
  return {
    reporterNameText: contact.teamMember || '',
    memberOpenId: contact.teamMemberId || '',
    agileGroup: contact.agileGroup || '',
    supervisor: contact.supervisor || '',
    supervisorOpenId: contact.supervisorOpenId || '',
    divisionalLeader: contact.divisionalLeader || '',
    divisionalLeaderOpenId: contact.divisionalLeaderOpenId || '',
    matchingStatus: contact.matchingStatus || '已匹配',
    matchMethod: contact.matchMethod || '',
  };
}

export function resolveOrganizationSnapshot({
  contact = null,
  existingSnapshot = {},
  repairOrganization = false,
} = {}) {
  const existingMatched = isMatchedOrganizationStatus(existingSnapshot.matchingStatus);
  if (contact && (repairOrganization || !existingMatched)) {
    return { snapshot: snapshotFromContact(contact), matched: true, source: 'contact' };
  }
  if (existingMatched) {
    return { snapshot: { ...EMPTY_SNAPSHOT, ...existingSnapshot }, matched: true, source: 'existing' };
  }
  return { snapshot: { ...EMPTY_SNAPSHOT }, matched: false, source: 'unmatched' };
}
