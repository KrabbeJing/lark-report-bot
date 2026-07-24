const MATCHED_STATUSES = new Set(['已匹配', '姓名匹配']);

const EMPTY_SNAPSHOT = Object.freeze({
  reporterNameText: '',
  memberOpenId: '',
  supervisor: '',
  supervisorOpenId: '',
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
    supervisor: contact.supervisor || '',
    supervisorOpenId: contact.supervisorOpenId || '',
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
    return {
      snapshot: {
        ...EMPTY_SNAPSHOT,
        reporterNameText: existingSnapshot.reporterNameText || '',
        memberOpenId: existingSnapshot.memberOpenId || '',
        supervisor: existingSnapshot.supervisor || '',
        supervisorOpenId: existingSnapshot.supervisorOpenId || '',
        matchingStatus: existingSnapshot.matchingStatus || '已匹配',
        matchMethod: existingSnapshot.matchMethod || '',
      },
      matched: true,
      source: 'existing',
    };
  }
  return { snapshot: { ...EMPTY_SNAPSHOT }, matched: false, source: 'unmatched' };
}
