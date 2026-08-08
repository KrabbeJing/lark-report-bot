export function createMessageDeduper({ maxSize = 1000 } = {}) {
  const processed = new Map();
  const processing = new Set();

  return {
    begin(messageId, fingerprint) {
      const id = String(messageId || '');
      if (!id || processing.has(id)) return false;
      if (processed.get(id) === String(fingerprint || '')) return false;
      processing.add(id);
      return true;
    },

    complete(messageId, fingerprint) {
      const id = String(messageId || '');
      processing.delete(id);
      if (!id) return;
      processed.set(id, String(fingerprint || ''));
      while (processed.size > maxSize) {
        processed.delete(processed.keys().next().value);
      }
    },

    fail(messageId) {
      processing.delete(String(messageId || ''));
    },
  };
}
