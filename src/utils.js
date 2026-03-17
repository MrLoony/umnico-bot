const fs = require("node:fs/promises");
const path = require("node:path");

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function toLowerNormalized(value) {
  return normalizeText(value).toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(value, maxLength = 160) {
  const text = normalizeText(value);
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function parseTimestamp(timestampText) {
  const normalized = normalizeText(timestampText);
  const match = normalized.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const year = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);

  if (
    monthIndex < 0 ||
    monthIndex > 11 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  const parsed = new Date(year, monthIndex, day, hour, minute);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== monthIndex ||
    parsed.getDate() !== day ||
    parsed.getHours() !== hour ||
    parsed.getMinutes() !== minute
  ) {
    return null;
  }

  return parsed;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    return fallbackValue;
  }
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function uniqueNonEmpty(values) {
  const result = [];
  const seen = new Set();

  for (const value of values || []) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function resolveProjectPath(rootDir, maybeRelativePath) {
  if (!maybeRelativePath) {
    return rootDir;
  }

  return path.isAbsolute(maybeRelativePath)
    ? maybeRelativePath
    : path.resolve(rootDir, maybeRelativePath);
}

function buildComparableDealId(rawHref, baseUrl) {
  const href = normalizeText(rawHref);
  if (!href) {
    return "";
  }

  try {
    const url = new URL(href, baseUrl);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (error) {
    return href;
  }
}

module.exports = {
  buildComparableDealId,
  ensureDir,
  normalizeText,
  nowIso,
  parseTimestamp,
  readJson,
  resolveProjectPath,
  sleep,
  toLowerNormalized,
  truncate,
  uniqueNonEmpty,
  writeJson,
};
