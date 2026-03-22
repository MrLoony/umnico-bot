const fs = require("node:fs/promises");
const path = require("node:path");
const {
  ensureDir,
  readJson,
  resolveProjectPath,
  writeJson,
} = require("./utils");

const DEFAULT_CONFIG = {
  url: "https://app.umnico.com/",
  dryRun: true,
  headless: false,
  autoNavigateOnStart: false,
  initialGotoTimeoutMs: 30000,
  pollIntervalMs: 1200,
  openChatTimeoutMs: 7000,
  acceptButtonTimeoutMs: 4000,
  postOpenDelayMs: 600,
  postAcceptDelayMs: 800,
  betweenDealsDelayMs: 300,
  maxLastMessages: 3,
  ambiguousPreviewWordCount: 3,
  browserUserDataDir: "./data/browser-profile",
  acceptCandidateThreshold: 8,
  openCheckThreshold: 2,
  strongNegativeThreshold: -4,
  includeWeights: {},
  includeKeywords: {},
  excludeWeights: {},
  excludeKeywords: {},
  phraseWeights: {},
  brandWeights: {},
  modelWeights: {},
  sourceWeights: {},
  ownershipIgnoredOutgoingPatterns: [],
  ownershipRules: {
    enabled: false,
    timezone: "UTC",
    dayBoundaryTime: "10:00",
    currentUserName: "",
    assistantNames: [],
    ownershipIgnoredOutgoingPatterns: [],
  },
  watchlist: {
    enabled: true,
    cooldownSeconds: 90,
    ttlMinutes: 180,
    maxRetries: 8,
  },
};

function mergeConfig(rawConfig) {
  const normalizedConfig = {
    ...DEFAULT_CONFIG,
    ...(rawConfig || {}),
  };

  normalizedConfig.includeKeywords = {
    ...DEFAULT_CONFIG.includeKeywords,
    ...(rawConfig?.includeKeywords || {}),
  };

  normalizedConfig.includeWeights = {
    ...DEFAULT_CONFIG.includeWeights,
    ...(rawConfig?.includeKeywords || {}),
    ...(rawConfig?.includeWeights || {}),
  };

  normalizedConfig.excludeKeywords = {
    ...DEFAULT_CONFIG.excludeKeywords,
    ...(rawConfig?.excludeKeywords || {}),
  };

  normalizedConfig.excludeWeights = {
    ...DEFAULT_CONFIG.excludeWeights,
    ...(rawConfig?.excludeKeywords || {}),
    ...(rawConfig?.excludeWeights || {}),
  };

  normalizedConfig.phraseWeights = {
    ...DEFAULT_CONFIG.phraseWeights,
    ...(rawConfig?.phraseWeights || {}),
  };

  normalizedConfig.brandWeights = {
    ...DEFAULT_CONFIG.brandWeights,
    ...(rawConfig?.brandWeights || {}),
  };

  normalizedConfig.modelWeights = {
    ...DEFAULT_CONFIG.modelWeights,
    ...(rawConfig?.modelWeights || {}),
  };

  normalizedConfig.sourceWeights = {
    ...DEFAULT_CONFIG.sourceWeights,
    ...(rawConfig?.sourceWeights || {}),
  };

  normalizedConfig.ownershipIgnoredOutgoingPatterns = Array.isArray(
    rawConfig?.ownershipIgnoredOutgoingPatterns,
  )
    ? rawConfig.ownershipIgnoredOutgoingPatterns
    : DEFAULT_CONFIG.ownershipIgnoredOutgoingPatterns;

  normalizedConfig.ownershipRules = {
    ...DEFAULT_CONFIG.ownershipRules,
    ...(rawConfig?.shiftRules || {}),
    ...(rawConfig?.ownershipRules || {}),
    dayBoundaryTime:
      typeof rawConfig?.ownershipRules?.dayBoundaryTime === "string"
        ? rawConfig.ownershipRules.dayBoundaryTime
        : typeof rawConfig?.ownershipRules?.dayShiftStartsAt === "string"
          ? rawConfig.ownershipRules.dayShiftStartsAt
          : typeof rawConfig?.shiftRules?.dayBoundaryTime === "string"
            ? rawConfig.shiftRules.dayBoundaryTime
            : typeof rawConfig?.shiftRules?.dayShiftStartsAt === "string"
              ? rawConfig.shiftRules.dayShiftStartsAt
              : DEFAULT_CONFIG.ownershipRules.dayBoundaryTime,
    currentUserName:
      typeof rawConfig?.ownershipRules?.currentUserName === "string"
        ? rawConfig.ownershipRules.currentUserName
        : typeof rawConfig?.shiftRules?.currentUserName === "string"
          ? rawConfig.shiftRules.currentUserName
          : DEFAULT_CONFIG.ownershipRules.currentUserName,
    assistantNames: Array.isArray(rawConfig?.ownershipRules?.assistantNames)
      ? rawConfig.ownershipRules.assistantNames
      : Array.isArray(rawConfig?.shiftRules?.assistantNames)
        ? rawConfig.shiftRules.assistantNames
        : DEFAULT_CONFIG.ownershipRules.assistantNames,
    ownershipIgnoredOutgoingPatterns: Array.isArray(
      rawConfig?.ownershipRules?.ownershipIgnoredOutgoingPatterns,
    )
      ? rawConfig.ownershipRules.ownershipIgnoredOutgoingPatterns
      : normalizedConfig.ownershipIgnoredOutgoingPatterns,
  };

  normalizedConfig.shiftRules = {
    ...normalizedConfig.ownershipRules,
    dayShiftStartsAt: normalizedConfig.ownershipRules.dayBoundaryTime,
    assistantNames: [...normalizedConfig.ownershipRules.assistantNames],
    ownershipIgnoredOutgoingPatterns: [
      ...normalizedConfig.ownershipRules.ownershipIgnoredOutgoingPatterns,
    ],
  };

  normalizedConfig.watchlist = {
    ...DEFAULT_CONFIG.watchlist,
    ...(rawConfig?.watchlist || {}),
    enabled:
      typeof rawConfig?.watchlist?.enabled === "boolean"
        ? rawConfig.watchlist.enabled
        : DEFAULT_CONFIG.watchlist.enabled,
    cooldownSeconds: Number.isFinite(
      Number(rawConfig?.watchlist?.cooldownSeconds),
    )
      ? Number(rawConfig.watchlist.cooldownSeconds)
      : DEFAULT_CONFIG.watchlist.cooldownSeconds,
    ttlMinutes: Number.isFinite(Number(rawConfig?.watchlist?.ttlMinutes))
      ? Number(rawConfig.watchlist.ttlMinutes)
      : DEFAULT_CONFIG.watchlist.ttlMinutes,
    maxRetries: Number.isFinite(Number(rawConfig?.watchlist?.maxRetries))
      ? Number(rawConfig.watchlist.maxRetries)
      : DEFAULT_CONFIG.watchlist.maxRetries,
  };

  normalizedConfig.postAcceptDelayMs = Number.isFinite(
    Number(rawConfig?.postAcceptDelayMs),
  )
    ? Number(rawConfig.postAcceptDelayMs)
    : DEFAULT_CONFIG.postAcceptDelayMs;

  normalizedConfig.acceptButtonTimeoutMs = Number.isFinite(
    Number(rawConfig?.acceptButtonTimeoutMs),
  )
    ? Number(rawConfig.acceptButtonTimeoutMs)
    : DEFAULT_CONFIG.acceptButtonTimeoutMs;

  return normalizedConfig;
}

async function ensureProjectFiles(rootDir) {
  const dataDir = path.join(rootDir, "data");
  const logsDir = path.join(rootDir, "logs");
  const configDir = path.join(rootDir, "config");

  await Promise.all([
    ensureDir(dataDir),
    ensureDir(logsDir),
    ensureDir(configDir),
  ]);

  const seenPath = path.join(dataDir, "seen.json");
  const watchlistPath = path.join(dataDir, "watchlist.json");
  const logPath = path.join(logsDir, "log.txt");

  const seenExists = await fileExists(seenPath);
  if (!seenExists) {
    await writeJson(seenPath, []);
  }

  const watchlistExists = await fileExists(watchlistPath);
  if (!watchlistExists) {
    await writeJson(watchlistPath, {});
  }

  const logExists = await fileExists(logPath);
  if (!logExists) {
    await fs.writeFile(logPath, "", "utf8");
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

async function loadConfig(rootDir, configPath) {
  const absolutePath = resolveProjectPath(rootDir, configPath);
  const rawConfig = await readJson(absolutePath, DEFAULT_CONFIG);
  return mergeConfig(rawConfig);
}

async function loadSeenSet(rootDir, seenPath) {
  const absolutePath = resolveProjectPath(rootDir, seenPath);
  const rawValue = await readJson(absolutePath, []);
  const values = Array.isArray(rawValue) ? rawValue : [];
  return new Set(
    values.filter((item) => typeof item === "string" && item.trim()),
  );
}

async function saveSeenSet(rootDir, seenPath, seenSet) {
  const absolutePath = resolveProjectPath(rootDir, seenPath);
  await writeJson(absolutePath, Array.from(seenSet));
}

function isObjectRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeWatchlist(rawValue) {
  if (!isObjectRecord(rawValue)) {
    return {};
  }

  const normalizedEntries = {};
  for (const [dealId, entry] of Object.entries(rawValue)) {
    if (
      typeof dealId !== "string" ||
      !dealId.trim() ||
      !isObjectRecord(entry)
    ) {
      continue;
    }

    normalizedEntries[dealId] = {
      status: typeof entry.status === "string" ? entry.status : "watch",
      firstSeenAt:
        typeof entry.firstSeenAt === "string" ? entry.firstSeenAt : "",
      lastCheckedAt:
        typeof entry.lastCheckedAt === "string" ? entry.lastCheckedAt : "",
      lastPreviewText:
        typeof entry.lastPreviewText === "string" ? entry.lastPreviewText : "",
      lastTimeText:
        typeof entry.lastTimeText === "string" ? entry.lastTimeText : "",
      retryCount: Number.isFinite(Number(entry.retryCount))
        ? Number(entry.retryCount)
        : 0,
      expiresAt: typeof entry.expiresAt === "string" ? entry.expiresAt : "",
      reason: typeof entry.reason === "string" ? entry.reason : "",
    };
  }

  return normalizedEntries;
}

async function loadWatchlist(rootDir, watchlistPath) {
  const absolutePath = resolveProjectPath(rootDir, watchlistPath);
  const rawValue = await readJson(absolutePath, {});
  return normalizeWatchlist(rawValue);
}

async function saveWatchlist(rootDir, watchlistPath, watchlist) {
  const absolutePath = resolveProjectPath(rootDir, watchlistPath);
  await writeJson(absolutePath, normalizeWatchlist(watchlist));
}

module.exports = {
  ensureProjectFiles,
  loadConfig,
  loadSeenSet,
  loadWatchlist,
  saveSeenSet,
  saveWatchlist,
};
