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
  postOpenDelayMs: 600,
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
  const logPath = path.join(logsDir, "log.txt");

  const seenExists = await fileExists(seenPath);
  if (!seenExists) {
    await writeJson(seenPath, []);
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

module.exports = {
  ensureProjectFiles,
  loadConfig,
  loadSeenSet,
  saveSeenSet,
};
