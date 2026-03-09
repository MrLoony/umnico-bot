const selectors = require('./selectors');
const { normalizeText, sleep, uniqueNonEmpty } = require('./utils');

const INCOMING_HINTS = [
  'incoming',
  'inbound',
  'received',
  'client',
  'customer',
  'guest',
  'lead',
  'visitor',
  'external',
  'from-client',
  'from-user',
  'message-in'
];

const OUTGOING_HINTS = [
  'outgoing',
  'outbound',
  'sent',
  'operator',
  'manager',
  'agent',
  'employee',
  'company',
  'support-reply',
  'from-company',
  'my-message',
  'message-out'
];

const MANAGER_NAME_SELECTORS = [
  '[data-manager-name]',
  '[data-user-name]',
  '[data-sender-name]',
  '[class*="author"]',
  '[class*="sender"]',
  '[class*="manager"]',
  '[class*="operator"]',
  '[class*="employee"]',
  '[class*="user"]',
  '[aria-label]',
  '[title]'
];

const TIMESTAMP_SELECTORS = [
  'time[datetime]',
  'time',
  '[data-timestamp]',
  '[data-time]',
  '[class*="timestamp"]',
  '[class*="date"]',
  '[class*="time"]',
  '[class*="meta"]',
  '[class*="status"]',
  '[class*="info"]'
];

async function readOpenChat(page, logger, config) {
  const historyLocator = page.locator(selectors.chat.history);

  try {
    await historyLocator.waitFor({ state: 'visible', timeout: config.openChatTimeoutMs });
  } catch (error) {
    await logger.warn('Open chat history container was not found in time', {
      error: error.message,
      selector: selectors.chat.history
    });

    return {
      sourceOpenChat: '',
      lastMessages: [],
      lastIncomingCandidateMessages: [],
      incomingDetectionMode: 'history_not_found',
      messageTimeline: [],
      acceptButtonDetected: false
    };
  }

  if (config.postOpenDelayMs > 0) {
    await sleep(config.postOpenDelayMs);
  }

  const messageSnapshot = await page.locator(selectors.chat.messageItem).evaluateAll((nodes, payload) => {
    const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

    const looksLikeTimestamp = (value) => {
      const normalized = cleanText(value).toLowerCase();
      return Boolean(
        normalized.match(/\b\d{1,2}:\d{2}\b/)
        || normalized.match(/\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/)
        || normalized.includes('today')
        || normalized.includes('yesterday')
        || normalized.includes('сегодня')
        || normalized.includes('вчера')
      );
    };

    const collectMetadata = (node) => {
      const metadataParts = [];
      let current = node;
      let depth = 0;

      while (current && depth < 4) {
        metadataParts.push(current.className || '');
        metadataParts.push(current.getAttribute('data-direction') || '');
        metadataParts.push(current.getAttribute('data-message-direction') || '');
        metadataParts.push(current.getAttribute('data-side') || '');
        metadataParts.push(current.getAttribute('data-align') || '');
        metadataParts.push(current.getAttribute('aria-label') || '');
        metadataParts.push(current.getAttribute('title') || '');
        current = current.parentElement;
        depth += 1;
      }

      return cleanText(metadataParts.join(' ')).toLowerCase();
    };

    const collectNearbyNodes = (node, selectorList) => {
      const found = [];
      const seen = new Set();
      let current = node;
      let depth = 0;

      while (current && depth < 3) {
        for (const selector of selectorList) {
          for (const candidate of current.querySelectorAll(selector)) {
            if (seen.has(candidate)) {
              continue;
            }

            seen.add(candidate);
            found.push(candidate);
          }
        }

        current = current.parentElement;
        depth += 1;
      }

      return found;
    };

    const inferDirection = (metadata) => {
      const incomingScore = payload.incomingHints.reduce((score, hint) => (
        metadata.includes(hint) ? score + 1 : score
      ), 0);
      const outgoingScore = payload.outgoingHints.reduce((score, hint) => (
        metadata.includes(hint) ? score + 1 : score
      ), 0);

      if (incomingScore > outgoingScore && incomingScore > 0) {
        return 'incoming';
      }

      if (outgoingScore > incomingScore && outgoingScore > 0) {
        return 'outgoing';
      }

      return 'unknown';
    };

    const extractManagerName = (node, messageText, metadata) => {
      const nearbyNodes = collectNearbyNodes(node, payload.managerNameSelectors);
      const candidateTexts = nearbyNodes
        .flatMap((candidate) => ([
          candidate.getAttribute('data-manager-name') || '',
          candidate.getAttribute('data-user-name') || '',
          candidate.getAttribute('data-sender-name') || '',
          candidate.getAttribute('aria-label') || '',
          candidate.getAttribute('title') || '',
          candidate.textContent || ''
        ]))
        .map((value) => cleanText(value))
        .filter((value) => value && value !== messageText && value.length <= 140);

      const combinedMetadata = cleanText([metadata, ...candidateTexts].join(' | '));
      const explicitPatterns = [
        /отправлено пользователем\s+[«„"]?([^"»“]+)[»”"]?/i,
        /отправлено менеджером\s+[«„"]?([^"»“]+)[»”"]?/i,
        /sent by (?:user|manager|agent)\s+[«„"]?([^"»“]+)[»”"]?/i
      ];

      for (const pattern of explicitPatterns) {
        const match = combinedMetadata.match(pattern);
        if (match && cleanText(match[1])) {
          return cleanText(match[1]);
        }
      }

      const directName = candidateTexts.find((value) => !looksLikeTimestamp(value));
      return directName || '';
    };

    const extractTimestampText = (node, metadata) => {
      const nearbyNodes = collectNearbyNodes(node, payload.timestampSelectors);
      const candidateValues = nearbyNodes
        .flatMap((candidate) => ([
          candidate.getAttribute('datetime') || '',
          candidate.getAttribute('data-timestamp') || '',
          candidate.getAttribute('data-time') || '',
          candidate.getAttribute('aria-label') || '',
          candidate.getAttribute('title') || '',
          candidate.textContent || ''
        ]))
        .map((value) => cleanText(value))
        .filter(Boolean);

      const explicitValue = candidateValues.find((value) => looksLikeTimestamp(value));
      if (explicitValue) {
        return explicitValue;
      }

      return looksLikeTimestamp(metadata) ? metadata : '';
    };

    const messages = nodes.map((node) => {
      const text = cleanText(
        Array.from(node.querySelectorAll(payload.messageTextSelector))
          .map((item) => cleanText(item.textContent || ''))
          .filter(Boolean)
          .join(' ')
      );

      if (!text) {
        return null;
      }

      const metadata = collectMetadata(node);
      return {
        text,
        direction: inferDirection(metadata),
        managerName: extractManagerName(node, text, metadata),
        timestampText: extractTimestampText(node, metadata)
      };
    }).filter(Boolean);

    const incomingMessages = messages
      .filter((message) => message.direction === 'incoming')
      .map((message) => message.text)
      .slice(-payload.maxLastMessages);

    return {
      lastMessages: messages
        .map((message) => message.text)
        .slice(-payload.maxLastMessages),
      lastIncomingCandidateMessages: incomingMessages,
      incomingDetectionMode: incomingMessages.length ? 'heuristic_message_item' : 'fallback_all_messages',
      messageTimeline: messages
    };
  }, {
    incomingHints: INCOMING_HINTS,
    outgoingHints: OUTGOING_HINTS,
    managerNameSelectors: MANAGER_NAME_SELECTORS,
    timestampSelectors: TIMESTAMP_SELECTORS,
    maxLastMessages: config.maxLastMessages,
    messageTextSelector: '.im-message-text-block .im-message__text'
  });

  let lastMessages = (messageSnapshot.lastMessages || []).map((item) => normalizeText(item)).filter(Boolean);
  let lastIncomingCandidateMessages = (messageSnapshot.lastIncomingCandidateMessages || [])
    .map((item) => normalizeText(item))
    .filter(Boolean);
  let incomingDetectionMode = messageSnapshot.incomingDetectionMode || 'fallback_all_messages';
  let messageTimeline = Array.isArray(messageSnapshot.messageTimeline)
    ? messageSnapshot.messageTimeline.map((message) => ({
      direction: normalizeText(message.direction) || 'unknown',
      managerName: normalizeText(message.managerName),
      text: normalizeText(message.text),
      timestampText: normalizeText(message.timestampText)
    })).filter((message) => message.text)
    : [];

  if (!lastMessages.length) {
    const fallbackMessages = await page.locator(selectors.chat.messageText).evaluateAll((nodes, maxLastMessages) => {
      return nodes
        .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(-maxLastMessages);
    }, config.maxLastMessages);

    lastMessages = fallbackMessages.map((item) => normalizeText(item)).filter(Boolean);
    lastIncomingCandidateMessages = [];
    incomingDetectionMode = 'fallback_message_text_selector';
    messageTimeline = lastMessages.map((text) => ({
      direction: 'unknown',
      managerName: '',
      text,
      timestampText: ''
    }));
  }

  const sourceBlocks = await page.locator(selectors.chat.source).evaluateAll((nodes) => {
    return nodes
      .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  });

  const acceptButtonDetected = (await page.locator(selectors.acceptButton).count()) > 0;

  return {
    sourceOpenChat: normalizeText(uniqueNonEmpty(sourceBlocks).join(' | ')),
    lastMessages,
    lastIncomingCandidateMessages,
    incomingDetectionMode,
    messageTimeline,
    acceptButtonDetected
  };
}

module.exports = {
  readOpenChat
};
