const fs = require("node:fs/promises");
const path = require("node:path");
const { nowIso } = require("./utils");

function createLogger({ logPath, onEvent }) {
  async function appendRecord(record) {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  async function log(level, message, extra = {}) {
    const record = {
      kind: "event",
      timestamp: nowIso(),
      level,
      message,
      ...extra,
    };

    onEvent?.(`[${level.toUpperCase()}] ${message}`);
    await appendRecord(record);
  }

  async function logDecision(payload) {
    const record = {
      kind: "decision",
      timestamp: payload.timestamp || nowIso(),
      ...payload,
    };

    const scoreLabel = record.scoringBypassed ? "bypassed" : record.finalScore;
    const summary = `${record.decision} ${record.userName || "Unknown"} score=${scoreLabel} ${record.dealId}`;
    onEvent?.(summary);
    await appendRecord(record);
  }

  return {
    debug: (message, extra) => log("debug", message, extra),
    error: (message, extra) => log("error", message, extra),
    info: (message, extra) => log("info", message, extra),
    logDecision,
    warn: (message, extra) => log("warn", message, extra),
  };
}

module.exports = {
  createLogger,
};
