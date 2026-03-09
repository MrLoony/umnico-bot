const { normalizeText, toLowerNormalized } = require('./utils');

const TOKEN_CHAR_REGEX = /[\p{L}\p{N}]/u;

function isTokenChar(character) {
  return TOKEN_CHAR_REGEX.test(character || '');
}

function isBoundaryMatch(text, startIndex, endIndex) {
  const previousCharacter = startIndex > 0 ? text[startIndex - 1] : '';
  const nextCharacter = endIndex < text.length ? text[endIndex] : '';

  const leftBoundaryOk = startIndex === 0 || !isTokenChar(previousCharacter);
  const rightBoundaryOk = endIndex === text.length || !isTokenChar(nextCharacter);

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
          length: normalizedKeyword.length
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
    const overlaps = acceptedMatches.some((accepted) => !(match.end <= accepted.start || match.start >= accepted.end));
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
        delta: 0
      });
    }

    const hit = hitMap.get(match.keyword);
    hit.occurrences += 1;
    hit.delta += match.weight;
  }

  return {
    score,
    hits: Array.from(hitMap.values())
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

function scoreWeightGroups(text, groups, bucketSuffix = '') {
  let score = 0;
  const hits = [];

  for (const group of groups) {
    const groupScore = scoreKeywordMap(text, group.weights);
    if (!groupScore.hits.length) {
      continue;
    }

    score += groupScore.score;
    hits.push(...groupScore.hits.map((item) => ({
      ...item,
      bucket: `${group.bucket}${bucketSuffix}`
    })));
  }

  return { score, hits };
}

function emptyScore() {
  return { score: 0, hits: [] };
}

function getPositivePreviewGroups(config) {
  return [
    {
      bucket: 'include',
      weights: mergeWeightMaps(config.includeKeywords, config.includeWeights)
    },
    {
      bucket: 'phrase',
      weights: config.phraseWeights
    },
    {
      bucket: 'brand',
      weights: config.brandWeights
    },
    {
      bucket: 'model',
      weights: config.modelWeights
    }
  ];
}

function getNegativePreviewGroups(config) {
  return [
    {
      bucket: 'exclude',
      weights: mergeWeightMaps(config.excludeKeywords, config.excludeWeights)
    }
  ];
}

function getSourceGroups(config) {
  return [
    {
      bucket: 'source',
      weights: config.sourceWeights
    }
  ];
}

function hasPositiveTextSignal(...scores) {
  return scores.some((score) => Array.isArray(score.hits) && score.hits.length > 0 && score.score > 0);
}

function selectMessagesForFinalAssessment(chatSnapshot) {
  const incomingMessages = Array.isArray(chatSnapshot?.lastIncomingCandidateMessages)
    ? chatSnapshot.lastIncomingCandidateMessages.map((item) => normalizeText(item)).filter(Boolean)
    : [];
  const lastMessages = Array.isArray(chatSnapshot?.lastMessages)
    ? chatSnapshot.lastMessages.map((item) => normalizeText(item)).filter(Boolean)
    : [];

  if (incomingMessages.length) {
    return {
      messages: incomingMessages,
      basis: 'incoming_candidates'
    };
  }

  return {
    messages: lastMessages,
    basis: 'all_messages_fallback'
  };
}

function buildPreliminaryAssessment(deal, config) {
  const previewPositiveScore = scoreWeightGroups(deal.previewText, getPositivePreviewGroups(config));
  const previewNegativeScore = scoreWeightGroups(deal.previewText, getNegativePreviewGroups(config));
  const sourceScore = hasPositiveTextSignal(previewPositiveScore)
    ? scoreWeightGroups(deal.sourcePreview, getSourceGroups(config))
    : emptyScore();
  const combinedScore = previewPositiveScore.score + previewNegativeScore.score + sourceScore.score;
  const combinedHits = [
    ...previewPositiveScore.hits,
    ...previewNegativeScore.hits,
    ...sourceScore.hits
  ];

  const previewWordCount = normalizeText(deal.previewText).split(' ').filter(Boolean).length;
  const hasNegativeHits = previewNegativeScore.hits.length > 0;
  const ambiguousPreview = !normalizeText(deal.previewText) || previewWordCount <= config.ambiguousPreviewWordCount;
  const shouldOpen = combinedScore >= config.openCheckThreshold || ambiguousPreview;

  let decision = 'SKIP';
  if (combinedScore <= config.strongNegativeThreshold && hasNegativeHits) {
    decision = 'SKIP_STRONG_NEGATIVE';
  } else if (shouldOpen) {
    decision = 'OPEN_CHECK';
  }

  return {
    decision,
    hasNegativeHits,
    preliminaryScore: combinedScore,
    preliminaryHits: combinedHits,
    previewPositiveScore: previewPositiveScore.score,
    sourceModifierApplied: sourceScore.score !== 0,
    shouldOpen
  };
}

function buildFinalAssessment(deal, chatSnapshot, config) {
  const previewPositiveScore = scoreWeightGroups(deal.previewText, getPositivePreviewGroups(config));
  const previewNegativeScore = scoreWeightGroups(deal.previewText, getNegativePreviewGroups(config));
  const selectedMessages = selectMessagesForFinalAssessment(chatSnapshot);
  const messageText = selectedMessages.messages.join(' ');
  const messagePositiveScore = scoreWeightGroups(messageText, getPositivePreviewGroups(config), '_open_chat');
  const messageNegativeScore = scoreWeightGroups(messageText, getNegativePreviewGroups(config), '_open_chat');
  const sourceModifierAllowed = hasPositiveTextSignal(previewPositiveScore, messagePositiveScore);
  const sourcePreviewScore = sourceModifierAllowed
    ? scoreWeightGroups(deal.sourcePreview, getSourceGroups(config))
    : emptyScore();
  const sourceOpenChatScore = sourceModifierAllowed
    ? scoreWeightGroups(chatSnapshot.sourceOpenChat, getSourceGroups(config), '_open_chat')
    : emptyScore();

  const finalScore = previewPositiveScore.score
    + previewNegativeScore.score
    + messagePositiveScore.score
    + messageNegativeScore.score
    + sourcePreviewScore.score
    + sourceOpenChatScore.score;

  let decision = 'SKIP';
  if (finalScore <= config.strongNegativeThreshold) {
    decision = 'SKIP_STRONG_NEGATIVE';
  } else if (finalScore >= config.acceptCandidateThreshold) {
    decision = 'ACCEPT_CANDIDATE';
  } else if (finalScore >= config.openCheckThreshold) {
    decision = 'OPEN_CHECK';
  }

  return {
    decision,
    finalScore,
    scoringMessageBasis: selectedMessages.basis,
    scoringMessagesUsed: selectedMessages.messages,
    sourceModifierApplied: sourceModifierAllowed,
    finalHits: [
      ...previewPositiveScore.hits,
      ...previewNegativeScore.hits,
      ...sourcePreviewScore.hits,
      ...messagePositiveScore.hits,
      ...messageNegativeScore.hits,
      ...sourceOpenChatScore.hits
    ]
  };
}

module.exports = {
  buildFinalAssessment,
  buildPreliminaryAssessment,
  scoreKeywordMap
};
