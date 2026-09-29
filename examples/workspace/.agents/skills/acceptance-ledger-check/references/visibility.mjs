export function visibleLedgerEntries(membership, entries) {
  if (membership?.enabled !== true) {
    return { entries: [], reason: 'MEMBERSHIP_INACTIVE' };
  }
  return { entries, reason: null };
}
