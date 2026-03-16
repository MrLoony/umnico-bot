const { normalizeText, toLowerNormalized } = require("./utils");

const WATCH_REASON_SHORT_GREETING = "short_greeting_without_negative_signals";

const WEAK_GREETING_PATTERNS = [
  "hello",
  "hi",
  "hey",
  "good morning",
  "good afternoon",
  "good evening",
  "good day",
  "добрый день",
  "доброе утро",
  "добрый вечер",
  "здравствуйте",
  "привет",
  "?",
  "??",
  "???",
  "can i call",
  "call?",
  "call me",
  "available",
  "available?",
  "availability",
  "availability?",
  "price",
  "price?",
];

const WEAK_GREETING_SET = new Set(
  WEAK_GREETING_PATTERNS.map((pattern) => toLowerNormalized(pattern)),
);
const WEAK_GREETING_PREFIXES = [
  "hello",
  "hi",
  "hey",
  "good morning",
  "good afternoon",
  "good evening",
  "good day",
  "добрый день",
  "доброе утро",
  "добрый вечер",
  "здравствуйте",
  "привет",
].map((pattern) => toLowerNormalized(pattern));

function getLatestWatchCandidateText(deal, chatSnapshot) {
  const previewText = normalizeText(deal?.previewText);
  if (previewText) {
    return previewText;
  }

  const incomingMessages = Array.isArray(
    chatSnapshot?.lastIncomingCandidateMessages,
  )
    ? chatSnapshot.lastIncomingCandidateMessages
        .map((item) => normalizeText(item))
        .filter(Boolean)
    : [];
  if (incomingMessages.length) {
    return incomingMessages[incomingMessages.length - 1];
  }

  const lastMessages = Array.isArray(chatSnapshot?.lastMessages)
    ? chatSnapshot.lastMessages
        .map((item) => normalizeText(item))
        .filter(Boolean)
    : [];
  if (lastMessages.length) {
    return lastMessages[lastMessages.length - 1];
  }

  return "";
}

function matchWeakGreetingPattern(text) {
  const normalizedText = toLowerNormalized(text);
  if (!normalizedText) {
    return { matched: false, pattern: "", kind: "" };
  }

  if (WEAK_GREETING_SET.has(normalizedText)) {
    return {
      matched: true,
      pattern: normalizedText,
      kind: "exact",
    };
  }

  if (/^\?{1,4}$/.test(normalizedText)) {
    return {
      matched: true,
      pattern: normalizedText,
      kind: "punctuation_only",
    };
  }

  const wordCount = normalizedText.split(" ").filter(Boolean).length;
  if (wordCount > 0 && wordCount <= 3) {
    const matchedPrefix = WEAK_GREETING_PREFIXES.find(
      (pattern) =>
        normalizedText === pattern || normalizedText.startsWith(`${pattern} `),
    );

    if (matchedPrefix) {
      return {
        matched: true,
        pattern: matchedPrefix,
        kind: "short_greeting_prefix",
      };
    }
  }

  return {
    matched: false,
    pattern: "",
    kind: "",
  };
}

function hasNegativeSignals(preliminary, finalAssessment) {
  const hits = [
    ...(Array.isArray(preliminary?.preliminaryHits)
      ? preliminary.preliminaryHits
      : []),
    ...(Array.isArray(finalAssessment?.finalHits)
      ? finalAssessment.finalHits
      : []),
  ];

  return hits.some((hit) =>
    String(hit?.bucket || "")
      .toLowerCase()
      .startsWith("exclude"),
  );
}

function hasOutgoingOnlyMessages(chatSnapshot) {
  const timeline = Array.isArray(chatSnapshot?.messageTimeline)
    ? chatSnapshot.messageTimeline
    : [];
  if (!timeline.length) {
    return false;
  }

  const incomingCount = timeline.filter(
    (message) => message?.direction === "incoming",
  ).length;
  const outgoingCount = timeline.filter(
    (message) => message?.direction === "outgoing",
  ).length;

  return outgoingCount > 0 && incomingCount === 0;
}

function getOwnershipDecision(ownership) {
  if (typeof ownership === "string") {
    return ownership;
  }

  return ownership?.ownershipDecision || ownership?.decision || "ALLOW_NORMAL";
}

function getWatchDecisionContext(
  deal,
  preliminary,
  chatSnapshot,
  finalAssessment,
  ownership,
) {
  const decision = finalAssessment?.decision || preliminary?.decision || "";
  const ownershipDecision = getOwnershipDecision(ownership);

  if (decision !== "SKIP") {
    return {
      shouldWatch: false,
      reason: "",
      matchedPattern: "",
      candidateText: "",
    };
  }

  if (ownershipDecision === "BLOCK_BY_OWNER_RULE") {
    return {
      shouldWatch: false,
      reason: "",
      matchedPattern: "",
      candidateText: "",
    };
  }

  if (ownershipDecision === "ALLOW_FORCE_SELF") {
    return {
      shouldWatch: false,
      reason: "",
      matchedPattern: "",
      candidateText: "",
    };
  }

  if (
    preliminary?.decision === "SKIP_STRONG_NEGATIVE" ||
    finalAssessment?.decision === "SKIP_STRONG_NEGATIVE" ||
    hasNegativeSignals(preliminary, finalAssessment)
  ) {
    return {
      shouldWatch: false,
      reason: "",
      matchedPattern: "",
      candidateText: "",
    };
  }

  if (hasOutgoingOnlyMessages(chatSnapshot)) {
    return {
      shouldWatch: false,
      reason: "",
      matchedPattern: "",
      candidateText: "",
    };
  }

  const candidateText = getLatestWatchCandidateText(deal, chatSnapshot);
  const weakMatch = matchWeakGreetingPattern(candidateText);
  if (!weakMatch.matched) {
    return {
      shouldWatch: false,
      reason: "",
      matchedPattern: "",
      candidateText,
    };
  }

  return {
    shouldWatch: true,
    reason: WATCH_REASON_SHORT_GREETING,
    matchedPattern: weakMatch.pattern,
    candidateText,
  };
}

function shouldWatchSkippedChat(
  deal,
  preliminary,
  chatSnapshot,
  finalAssessment,
  ownership,
) {
  return getWatchDecisionContext(
    deal,
    preliminary,
    chatSnapshot,
    finalAssessment,
    ownership,
  ).shouldWatch;
}

function parseDateValue(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function shouldRecheckWatchEntry(
  entry,
  deal,
  cooldownSeconds,
  now = new Date(),
) {
  const previousPreviewText = normalizeText(entry?.lastPreviewText);
  const previousTimeText = normalizeText(entry?.lastTimeText);
  const currentPreviewText = normalizeText(deal?.previewText);
  const currentTimeText = normalizeText(deal?.timeText);
  const lastCheckedAtMs = parseDateValue(entry?.lastCheckedAt);
  const safeCooldownSeconds = Math.max(0, Number(cooldownSeconds) || 0);
  const elapsedSeconds =
    lastCheckedAtMs === null
      ? safeCooldownSeconds
      : Math.max(0, Math.floor((now.getTime() - lastCheckedAtMs) / 1000));

  const previewChanged = previousPreviewText !== currentPreviewText;
  const timeChanged = previousTimeText !== currentTimeText;
  const cooldownElapsed = elapsedSeconds >= safeCooldownSeconds;
  const recheckAfterSeconds = cooldownElapsed
    ? 0
    : Math.max(0, safeCooldownSeconds - elapsedSeconds);

  return {
    shouldRecheck: previewChanged || timeChanged || cooldownElapsed,
    previewChanged,
    timeChanged,
    cooldownElapsed,
    recheckAfterSeconds,
  };
}

function isWatchlistEntryExpired(entry, watchlistConfig, now = new Date()) {
  const expiresAtMs = parseDateValue(entry?.expiresAt);
  const retryCount = Number(entry?.retryCount || 0);
  const maxRetries = Math.max(0, Number(watchlistConfig?.maxRetries) || 0);

  return {
    expiredByTime:
      expiresAtMs !== null && Number.isFinite(now.getTime())
        ? now.getTime() > expiresAtMs
        : false,
    expiredByRetries: retryCount > maxRetries,
  };
}

function buildWatchlistEntry({
  existingEntry,
  deal,
  now = new Date(),
  ttlMinutes,
  reason,
}) {
  const firstSeenAt =
    typeof existingEntry?.firstSeenAt === "string" && existingEntry.firstSeenAt
      ? existingEntry.firstSeenAt
      : now.toISOString();
  const expiresAt =
    typeof existingEntry?.expiresAt === "string" && existingEntry.expiresAt
      ? existingEntry.expiresAt
      : new Date(
          now.getTime() + Math.max(0, Number(ttlMinutes) || 0) * 60 * 1000,
        ).toISOString();

  return {
    status: "watch",
    firstSeenAt,
    lastCheckedAt: now.toISOString(),
    lastPreviewText: normalizeText(deal?.previewText),
    lastTimeText: normalizeText(deal?.timeText),
    retryCount: Number(existingEntry?.retryCount || 0) + 1,
    expiresAt,
    reason,
  };
}

module.exports = {
  WATCH_REASON_SHORT_GREETING,
  WEAK_GREETING_PATTERNS,
  buildWatchlistEntry,
  getWatchDecisionContext,
  isWatchlistEntryExpired,
  matchWeakGreetingPattern,
  shouldRecheckWatchEntry,
  shouldWatchSkippedChat,
};
