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
  shiftRules: {
    enabled: false,
    timezone: "UTC",
    dayShiftStartsAt: "10:00",
    myShift: "day",
    dayManagers: [],
    nightManagers: [],
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

  normalizedConfig.shiftRules = {
    ...DEFAULT_CONFIG.shiftRules,
    ...(rawConfig?.shiftRules || {}),
    dayManagers: Array.isArray(rawConfig?.shiftRules?.dayManagers)
      ? rawConfig.shiftRules.dayManagers
      : DEFAULT_CONFIG.shiftRules.dayManagers,
    nightManagers: Array.isArray(rawConfig?.shiftRules?.nightManagers)
      ? rawConfig.shiftRules.nightManagers
      : DEFAULT_CONFIG.shiftRules.nightManagers,
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
