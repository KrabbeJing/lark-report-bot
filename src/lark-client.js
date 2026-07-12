const SILENT_LARK_LOGGER = Object.freeze({
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
});

export function buildLarkClientOptions({ appId, appSecret, domain }) {
  return {
    appId,
    appSecret,
    domain,
    logger: SILENT_LARK_LOGGER,
  };
}
