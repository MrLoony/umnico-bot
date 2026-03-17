const { normalizeText, parseTimestamp, toLowerNormalized } = require("./utils");

const MAX_SCORING_MESSAGES = 3;
const MESSAGE_TIME_WINDOW_MS = 15 * 60 * 1000;

const TOKEN_CHAR_REGEX = /[\p{L}\p{N}]/u;

function isTokenChar(character) {
  return TOKEN_CHAR_REGEX.test(character || "");
}

function isBoundaryMatch(text, startIndex, endIndex) {
  const previousCharacter = startIndex > 0 ? text[startIndex - 1] : "";
  const nextCharacter = endIndex < text.length ? text[endIndex] : "";

  const leftBoundaryOk = startIndex === 0 || !isTokenChar(previousCharacter);
  const rightBoundaryOk =
    endIndex === text.length || !isTokenChar(nextCharacter);

  return leftBoundaryOk && rightBoundaryOk;
}

function findNonOverlappingMatches(text, keywordWeights) {
  const matches = [];
  const normalizedText = toLowerNormalized(text);

  for (const [keyword, rawWeight] of Object.entries(keywordWeights || {})) {
    const normalizedKeyword = toLowerNormalized(keyword);
    const weight = Number(rawWeight || 0);
    if (!normalizedKeyword || !weight) {
      continue;
    }

    let searchIndex = 0;
    while (searchIndex < normalizedText.length) {
      const matchIndex = normalizedText.indexOf(normalizedKeyword, searchIndex);
      if (matchIndex === -1) {
        break;
      }

      const matchEnd = matchIndex + normalizedKeyword.length;
      if (isBoundaryMatch(normalizedText, matchIndex, matchEnd)) {
        matches.push({
          keyword,
          weight,
          start: matchIndex,
          end: matchEnd,
          length: normalizedKeyword.length,
        });
      }

      searchIndex = matchIndex + 1;
    }
  }

  matches.sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }

    if (left.length !== right.length) {
      return right.length - left.length;
    }

    return Math.abs(right.weight) - Math.abs(left.weight);
  });

  const acceptedMatches = [];
  const acceptedByKeyword = new Map();

  for (const match of matches) {
    const overlaps = acceptedMatches.some(
      (accepted) =>
        !(match.end <= accepted.start || match.start >= accepted.end),
    );
    if (overlaps) {
      continue;
    }

    const previousCount = acceptedByKeyword.get(match.keyword) || 0;
    if (previousCount >= 2) {
      continue;
    }

    acceptedMatches.push(match);
    acceptedByKeyword.set(match.keyword, previousCount + 1);
  }

  return acceptedMatches;
}

function scoreKeywordMap(text, keywordWeights) {
  const matches = findNonOverlappingMatches(text, keywordWeights);
  const hitMap = new Map();
  let score = 0;

  for (const match of matches) {
    score += match.weight;

    if (!hitMap.has(match.keyword)) {
      hitMap.set(match.keyword, {
        keyword: match.keyword,
        weight: match.weight,
        occurrences: 0,
        delta: 0,
      });
    }

    const hit = hitMap.get(match.keyword);
    hit.occurrences += 1;
    hit.delta += match.weight;
  }

  return {
    score,
    hits: Array.from(hitMap.values()),
  };
}

function mergeWeightMaps(...weightMaps) {
  const result = {};

  for (const weightMap of weightMaps) {
    for (const [key, value] of Object.entries(weightMap || {})) {
      if (!normalizeText(key)) {
        continue;
      }

      result[key] = Number(value || 0);
    }
  }

  return result;
}

function scoreWeightGroups(text, groups, bucketSuffix = "") {
  let score = 0;
  const hits = [];

  for (const group of groups) {
    const groupScore = scoreKeywordMap(text, group.weights);
    if (!groupScore.hits.length) {
      continue;
    }

    score += groupScore.score;
    hits.push(
      ...groupScore.hits.map((item) => ({
        ...item,
        bucket: `${group.bucket}${bucketSuffix}`,
      })),
    );
  }

  return { score, hits };
}

function emptyScore() {
  return { score: 0, hits: [] };
}

function getPositivePreviewGroups(config) {
  return [
    {
      bucket: "include",
      weights: mergeWeightMaps(config.includeKeywords, config.includeWeights),
    },
    {
      bucket: "phrase",
      weights: config.phraseWeights,
    },
    {
      bucket: "brand",
      weights: config.brandWeights,
    },
    {
      bucket: "model",
      weights: config.modelWeights,
    },
  ];
}

function getNegativePreviewGroups(config) {
  return [
    {
      bucket: "exclude",
      weights: mergeWeightMaps(config.excludeKeywords, config.excludeWeights),
    },
  ];
}

function getSourceGroups(config) {
  return [
    {
      bucket: "source",
      weights: config.sourceWeights,
    },
  ];
}

function hasPositiveTextSignal(...scores) {
  return scores.some(
    (score) =>
      Array.isArray(score.hits) && score.hits.length > 0 && score.score > 0,
  );
}

function buildSelectionFromTextMessages(messages, basis) {
  const normalizedMessages = (messages || [])
    .map((item) => normalizeText(item))
    .filter(Boolean);

  return {
    messages: normalizedMessages,
    basis,
    scoringMessagesUsed: normalizedMessages.map((text) => ({
      text,
      timestampText: "",
    })),
    combinedText: normalizedMessages.join(" "),
  };
}

function buildSelectionFromTimelineMessages(messages, basis) {
  const scoringMessagesUsed = (messages || [])
    .map((message) => ({
      text: normalizeText(message?.text),
      timestampText: normalizeText(message?.timestampText),
    }))
    .filter((message) => message.text);

  return {
    messages: scoringMessagesUsed.map((message) => message.text),
    basis,
    scoringMessagesUsed,
    combinedText: scoringMessagesUsed.map((message) => message.text).join(" "),
  };
}

function selectFallbackMessagesForFinalAssessment(chatSnapshot) {
  const incomingMessages = Array.isArray(
    chatSnapshot?.lastIncomingCandidateMessages,
  )
    ? chatSnapshot.lastIncomingCandidateMessages
        .map((item) => normalizeText(item))
        .filter(Boolean)
    : [];
  const lastMessages = Array.isArray(chatSnapshot?.lastMessages)
    ? chatSnapshot.lastMessages
        .map((item) => normalizeText(item))
        .filter(Boolean)
    : [];

  if (incomingMessages.length) {
    return buildSelectionFromTextMessages(
      incomingMessages,
      "incoming_candidates",
    );
  }

  return buildSelectionFromTextMessages(lastMessages, "all_messages_fallback");
}

function selectMessagesForFinalAssessment(chatSnapshot) {
  const incomingTimelineMessages = Array.isArray(chatSnapshot?.messageTimeline)
    ? chatSnapshot.messageTimeline
        .map((message, index) => ({
          index,
          direction: normalizeText(message?.direction),
          text: normalizeText(message?.text),
          timestampText: normalizeText(message?.timestampText),
        }))
        .filter(
          (message) =>
            message.direction === "incoming" && message.text.length >= 2,
        )
    : [];

  if (!incomingTimelineMessages.length) {
    return selectFallbackMessagesForFinalAssessment(chatSnapshot);
  }

  const validTimedMessages = incomingTimelineMessages
    .map((message) => {
      const parsedTimestamp = parseTimestamp(message.timestampText);
      if (!parsedTimestamp) {
        return null;
      }

      return {
        ...message,
        parsedTimestamp,
        timestampMs: parsedTimestamp.getTime(),
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (right.timestampMs !== left.timestampMs) {
        return right.timestampMs - left.timestampMs;
      }

      return right.index - left.index;
    });

  if (!validTimedMessages.length) {
    return selectFallbackMessagesForFinalAssessment(chatSnapshot);
  }

  const anchorMessage = validTimedMessages[0];
  const selectedMessages = [];

  for (const message of validTimedMessages) {
    const timeGapMs = Math.abs(anchorMessage.timestampMs - message.timestampMs);
    if (timeGapMs > MESSAGE_TIME_WINDOW_MS) {
      break;
    }

    selectedMessages.push(message);
    if (selectedMessages.length >= MAX_SCORING_MESSAGES) {
      break;
    }
  }

  selectedMessages.sort((left, right) => {
    if (left.timestampMs !== right.timestampMs) {
      return left.timestampMs - right.timestampMs;
    }

    return left.index - right.index;
  });

  return buildSelectionFromTimelineMessages(
    selectedMessages,
    "multi_message_time_window",
  );
}

function buildPreliminaryAssessment(deal, config) {
  const previewPositiveScore = scoreWeightGroups(
    deal.previewText,
    getPositivePreviewGroups(config),
  );
  const previewNegativeScore = scoreWeightGroups(
    deal.previewText,
    getNegativePreviewGroups(config),
  );
  const sourceScore = hasPositiveTextSignal(previewPositiveScore)
    ? scoreWeightGroups(deal.sourcePreview, getSourceGroups(config))
    : emptyScore();
  const combinedScore =
    previewPositiveScore.score + previewNegativeScore.score + sourceScore.score;
  const combinedHits = [
    ...previewPositiveScore.hits,
    ...previewNegativeScore.hits,
    ...sourceScore.hits,
  ];

  const previewWordCount = normalizeText(deal.previewText)
    .split(" ")
    .filter(Boolean).length;
  const hasNegativeHits = previewNegativeScore.hits.length > 0;
  const ambiguousPreview =
    !normalizeText(deal.previewText) ||
    previewWordCount <= config.ambiguousPreviewWordCount;
  const shouldOpen =
    combinedScore >= config.openCheckThreshold || ambiguousPreview;

  let decision = "SKIP";
  if (combinedScore <= config.strongNegativeThreshold && hasNegativeHits) {
    decision = "SKIP_STRONG_NEGATIVE";
  } else if (shouldOpen) {
    decision = "OPEN_CHECK";
  }

  return {
    decision,
    hasNegativeHits,
    preliminaryScore: combinedScore,
    preliminaryHits: combinedHits,
    previewPositiveScore: previewPositiveScore.score,
    sourceModifierApplied: sourceScore.score !== 0,
    shouldOpen,
  };
}

function buildFinalAssessment(deal, chatSnapshot, config) {
  const previewPositiveScore = scoreWeightGroups(
    deal.previewText,
    getPositivePreviewGroups(config),
  );
  const previewNegativeScore = scoreWeightGroups(
    deal.previewText,
    getNegativePreviewGroups(config),
  );
  const selectedMessages = selectMessagesForFinalAssessment(chatSnapshot);
  const messageText = selectedMessages.combinedText;
  const messagePositiveScore = scoreWeightGroups(
    messageText,
    getPositivePreviewGroups(config),
    "_open_chat",
  );
  const messageNegativeScore = scoreWeightGroups(
    messageText,
    getNegativePreviewGroups(config),
    "_open_chat",
  );
  const sourceModifierAllowed = hasPositiveTextSignal(
    previewPositiveScore,
    messagePositiveScore,
  );
  const sourcePreviewScore = sourceModifierAllowed
    ? scoreWeightGroups(deal.sourcePreview, getSourceGroups(config))
    : emptyScore();
  const sourceOpenChatScore = sourceModifierAllowed
    ? scoreWeightGroups(
        chatSnapshot.sourceOpenChat,
        getSourceGroups(config),
        "_open_chat",
      )
    : emptyScore();

  const finalScore =
    previewPositiveScore.score +
    previewNegativeScore.score +
    messagePositiveScore.score +
    messageNegativeScore.score +
    sourcePreviewScore.score +
    sourceOpenChatScore.score;

  let decision = "SKIP";
  if (finalScore <= config.strongNegativeThreshold) {
    decision = "SKIP_STRONG_NEGATIVE";
  } else if (finalScore >= config.acceptCandidateThreshold) {
    decision = "ACCEPT_CANDIDATE";
  } else if (finalScore >= config.openCheckThreshold) {
    decision = "OPEN_CHECK";
  }

  return {
    decision,
    finalScore,
    scoringMessageBasis: selectedMessages.basis,
    scoringMessagesUsed: selectedMessages.scoringMessagesUsed,
    combinedText: selectedMessages.combinedText,
    sourceModifierApplied: sourceModifierAllowed,
    finalHits: [
      ...previewPositiveScore.hits,
      ...previewNegativeScore.hits,
      ...sourcePreviewScore.hits,
      ...messagePositiveScore.hits,
      ...messageNegativeScore.hits,
      ...sourceOpenChatScore.hits,
    ],
  };
}

module.exports = {
  buildFinalAssessment,
  buildPreliminaryAssessment,
  parseTimestamp,
  scoreKeywordMap,
};
