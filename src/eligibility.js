const { normalizeText, toLowerNormalized } = require("./utils");

const SOURCE_OPEN_CHAT_OUTGOING_MARKER_REGEX =
  /^(submitted by user|отправлено пользователем)\b/i;
const SOURCE_OPEN_CHAT_OUTGOING_QUOTED_NAME_REGEX =
  /^(submitted by user|отправлено пользователем)\s*(?:"([^"]+)"|“([^”]+)”|«([^»]+)»|„([^”]+)”)/i;
const SOURCE_OPEN_CHAT_OUTGOING_PLAIN_NAME_REGEX =
  /^(submitted by user|отправлено пользователем)\s*([^|]+?)(?=\s*(?:\.\.\.|[|,;]|$))/i;

function parseShiftTime(value) {
  const match = normalizeText(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return { hour: 10, minute: 0 };
  }

  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

function getZonedDateParts(timeZone, now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function compareDateParts(left, right) {
  const fields = ["year", "month", "day", "hour", "minute"];
  for (const field of fields) {
    const leftValue = Number(left[field] || 0);
    const rightValue = Number(right[field] || 0);

    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }

  return 0;
}

function isSameLocalDate(left, right) {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day
  );
}

function buildTodayShiftBoundary(ownershipRules, now = new Date()) {
  const timeZone = ownershipRules?.timezone || "UTC";
  const today = getZonedDateParts(timeZone, now);
  const shiftStart = parseShiftTime(
    ownershipRules?.dayBoundaryTime ||
      ownershipRules?.dayShiftStartsAt ||
      "10:00",
  );

  return {
    year: today.year,
    month: today.month,
    day: today.day,
    hour: shiftStart.hour,
    minute: shiftStart.minute,
  };
}

function parseMessageTimestamp(
  timestampText,
  ownershipRules,
  now = new Date(),
) {
  const raw = normalizeText(timestampText);
  if (!raw) {
    return null;
  }

  const lower = toLowerNormalized(raw);
  const timeZone = ownershipRules?.timezone || "UTC";
  const today = getZonedDateParts(timeZone, now);
  const yesterday = getZonedDateParts(
    timeZone,
    new Date(now.getTime() - 24 * 60 * 60 * 1000),
  );
  const timeMatch = lower.match(/(\d{1,2}):(\d{2})/);

  if (!timeMatch) {
    return null;
  }

  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);

  if (lower.includes("сегодня") || lower.includes("today")) {
    return {
      raw,
      year: today.year,
      month: today.month,
      day: today.day,
      hour,
      minute,
      source: "relative_today",
    };
  }

  if (lower.includes("вчера") || lower.includes("yesterday")) {
    return {
      raw,
      year: yesterday.year,
      month: yesterday.month,
      day: yesterday.day,
      hour,
      minute,
      source: "relative_yesterday",
    };
  }

  const isoMatch = lower.match(
    /(\d{4})[.-](\d{1,2})[.-](\d{1,2}).*?(\d{1,2}):(\d{2})/,
  );
  if (isoMatch) {
    return {
      raw,
      year: Number(isoMatch[1]),
      month: Number(isoMatch[2]),
      day: Number(isoMatch[3]),
      hour: Number(isoMatch[4]),
      minute: Number(isoMatch[5]),
      source: "iso_like",
    };
  }

  const localDateMatch = lower.match(
    /(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?.*?(\d{1,2}):(\d{2})/,
  );
  if (localDateMatch) {
    const parsedYear = localDateMatch[3]
      ? Number(
          localDateMatch[3].length === 2
            ? `20${localDateMatch[3]}`
            : localDateMatch[3],
        )
      : today.year;

    return {
      raw,
      year: parsedYear,
      month: Number(localDateMatch[2]),
      day: Number(localDateMatch[1]),
      hour: Number(localDateMatch[4]),
      minute: Number(localDateMatch[5]),
      source: localDateMatch[3]
        ? "date_time_with_year"
        : "date_time_without_year",
    };
  }

  return {
    raw,
    year: today.year,
    month: today.month,
    day: today.day,
    hour,
    minute,
    source: "time_only_assumed_today",
  };
}

function normalizeManagerName(value) {
  return toLowerNormalized(value).replace(/["'«»„“”]/g, "");
}

function matchConfiguredManager(managerName, candidates) {
  const normalizedTarget = normalizeManagerName(managerName);
  if (!normalizedTarget) {
    return "";
  }

  for (const candidate of candidates || []) {
    const normalizedCandidate = normalizeManagerName(candidate);
    if (!normalizedCandidate) {
      continue;
    }

    if (
      normalizedTarget === normalizedCandidate ||
      normalizedTarget.includes(normalizedCandidate) ||
      normalizedCandidate.includes(normalizedTarget)
    ) {
      return candidate;
    }
  }

  return "";
}

function matchesIgnoredOutgoingPattern(messageText, patterns) {
  const normalizedMessageText = toLowerNormalized(messageText);
  if (!normalizedMessageText) {
    return false;
  }

  for (const pattern of patterns || []) {
    const normalizedPattern = toLowerNormalized(pattern);
    if (!normalizedPattern) {
      continue;
    }

    if (
      normalizedMessageText === normalizedPattern ||
      normalizedMessageText.includes(normalizedPattern) ||
      normalizedPattern.includes(normalizedMessageText)
    ) {
      return true;
    }
  }

  return false;
}

function buildEligibilityResult(
  allowed,
  ownershipDecision,
  reason,
  message,
  matchedManager = "",
) {
  return {
    allowed,
    ownershipDecision,
    reason,
    matchedManager: matchedManager || normalizeText(message?.managerName),
    matchedTimestamp: normalizeText(message?.timestampText),
    lastOutgoingMessage: message || null,
  };
}

function inspectSourceOpenChatOwnershipSignal(sourceOpenChat, ownershipRules) {
  const normalizedSourceOpenChat = normalizeText(sourceOpenChat);
  const assistantNames = Array.isArray(ownershipRules?.assistantNames)
    ? ownershipRules.assistantNames
    : [];
  const extractedManagerNames = [];
  const sourceSegments = normalizedSourceOpenChat
    ? normalizedSourceOpenChat
        .split("|")
        .map((segment) => normalizeText(segment))
    : [];
  let hasManagerOutgoingMarkers = false;

  if (!normalizedSourceOpenChat) {
    return {
      hasManagerOutgoingMarkers: false,
      extractedManagerNames,
      matchedCurrentUser: "",
      matchedAssistant: "",
      matchedManager: "",
    };
  }

  for (const segment of sourceSegments) {
    if (!SOURCE_OPEN_CHAT_OUTGOING_MARKER_REGEX.test(segment)) {
      continue;
    }

    hasManagerOutgoingMarkers = true;

    const quotedNameMatch = segment.match(
      SOURCE_OPEN_CHAT_OUTGOING_QUOTED_NAME_REGEX,
    );
    const plainNameMatch = quotedNameMatch
      ? null
      : segment.match(SOURCE_OPEN_CHAT_OUTGOING_PLAIN_NAME_REGEX);
    const extractedManagerName = normalizeText(
      quotedNameMatch?.[2] ||
        quotedNameMatch?.[3] ||
        quotedNameMatch?.[4] ||
        quotedNameMatch?.[5] ||
        plainNameMatch?.[2] ||
        "",
    );

    if (extractedManagerName) {
      extractedManagerNames.push(extractedManagerName);
    }
  }

  const matchedCurrentUser =
    extractedManagerNames
      .map((managerName) =>
        matchConfiguredManager(managerName, [ownershipRules?.currentUserName]),
      )
      .find(Boolean) || "";
  const matchedAssistant =
    extractedManagerNames
      .map((managerName) => matchConfiguredManager(managerName, assistantNames))
      .find(Boolean) || "";

  return {
    hasManagerOutgoingMarkers,
    extractedManagerNames,
    matchedCurrentUser,
    matchedAssistant,
    matchedManager:
      matchedCurrentUser || matchedAssistant || extractedManagerNames[0] || "",
  };
}

function applySourceOpenChatOwnershipFallback(
  ownershipResult,
  sourceOpenChat,
  ownershipRules,
) {
  const indeterminateReasons = new Set([
    "no_meaningful_outgoing_manager_messages",
    "last_outgoing_timestamp_not_parsed",
  ]);

  if (!indeterminateReasons.has(ownershipResult?.reason)) {
    return ownershipResult;
  }

  const sourceOwnershipSignal = inspectSourceOpenChatOwnershipSignal(
    sourceOpenChat,
    ownershipRules,
  );

  if (
    sourceOwnershipSignal.hasManagerOutgoingMarkers &&
    sourceOwnershipSignal.matchedManager &&
    !sourceOwnershipSignal.matchedCurrentUser &&
    !sourceOwnershipSignal.matchedAssistant
  ) {
    return {
      allowed: false,
      ownershipDecision: "BLOCK_BY_OWNER_RULE",
      reason: "ownership_indeterminate_but_foreign_outgoing_markers_present",
      matchedManager: sourceOwnershipSignal.matchedManager,
      matchedTimestamp: "",
      lastOutgoingMessage: null,
    };
  }

  return ownershipResult;
}

function evaluateChatEligibility(
  messageTimeline,
  sourceOpenChat,
  ownershipRules,
  now = new Date(),
) {
  if (!ownershipRules?.enabled) {
    return {
      allowed: true,
      ownershipDecision: "ALLOW_NORMAL",
      reason: "ownership_rules_disabled",
      matchedManager: "",
      matchedTimestamp: "",
      lastOutgoingMessage: null,
    };
  }

  let ownershipResult;
  const timeline = Array.isArray(messageTimeline) ? messageTimeline : [];
  const ignoredOutgoingPatterns = Array.isArray(
    ownershipRules?.ownershipIgnoredOutgoingPatterns,
  )
    ? ownershipRules.ownershipIgnoredOutgoingPatterns
    : [];
  const lastOutgoingMessage = [...timeline]
    .reverse()
    .find(
      (message) =>
        normalizeManagerName(message?.direction) === "outgoing" &&
        !matchesIgnoredOutgoingPattern(message?.text, ignoredOutgoingPatterns),
    );

  if (!lastOutgoingMessage) {
    ownershipResult = {
      allowed: true,
      ownershipDecision: "ALLOW_NORMAL",
      reason: "no_meaningful_outgoing_manager_messages",
      matchedManager: "",
      matchedTimestamp: "",
      lastOutgoingMessage: null,
    };
    return applySourceOpenChatOwnershipFallback(
      ownershipResult,
      sourceOpenChat,
      ownershipRules,
    );
  }

  const shiftBoundary = buildTodayShiftBoundary(ownershipRules, now);
  const parsedTimestamp = parseMessageTimestamp(
    lastOutgoingMessage?.timestampText,
    ownershipRules,
    now,
  );

  if (!parsedTimestamp) {
    ownershipResult = buildEligibilityResult(
      true,
      "ALLOW_NORMAL",
      "last_outgoing_timestamp_not_parsed",
      lastOutgoingMessage,
    );
    return applySourceOpenChatOwnershipFallback(
      ownershipResult,
      sourceOpenChat,
      ownershipRules,
    );
  }

  if (!isSameLocalDate(parsedTimestamp, shiftBoundary)) {
    return buildEligibilityResult(
      true,
      "ALLOW_NORMAL",
      "last_outgoing_outside_current_boundary_date",
      lastOutgoingMessage,
    );
  }

  if (compareDateParts(parsedTimestamp, shiftBoundary) < 0) {
    return buildEligibilityResult(
      true,
      "ALLOW_NORMAL",
      "last_outgoing_before_boundary",
      lastOutgoingMessage,
    );
  }

  const matchedCurrentUser = matchConfiguredManager(
    lastOutgoingMessage?.managerName,
    [ownershipRules.currentUserName],
  );
  if (matchedCurrentUser) {
    return buildEligibilityResult(
      true,
      "ALLOW_FORCE_SELF",
      "latest_outgoing_after_boundary_belongs_to_current_user",
      lastOutgoingMessage,
      matchedCurrentUser,
    );
  }

  const assistantNames = Array.isArray(ownershipRules.assistantNames)
    ? ownershipRules.assistantNames
    : [];
  const matchedAssistant = matchConfiguredManager(
    lastOutgoingMessage?.managerName,
    assistantNames,
  );
  if (matchedAssistant) {
    return buildEligibilityResult(
      true,
      "ALLOW_NORMAL",
      "latest_outgoing_after_boundary_belongs_to_assistant",
      lastOutgoingMessage,
      matchedAssistant,
    );
  }

  return buildEligibilityResult(
    false,
    "BLOCK_BY_OWNER_RULE",
    "latest_outgoing_after_boundary_belongs_to_another_manager",
    lastOutgoingMessage,
  );
}

module.exports = {
  evaluateChatEligibility,
  parseMessageTimestamp,
};
