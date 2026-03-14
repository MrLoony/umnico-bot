const selectors = require("./selectors");
const { normalizeText, sleep, uniqueNonEmpty } = require("./utils");

async function readOpenChat(page, logger, config) {
  const historyLocator = page.locator(selectors.chat.history);

  try {
    await historyLocator.waitFor({
      state: "visible",
      timeout: config.openChatTimeoutMs,
    });
  } catch (error) {
    await logger.warn("Open chat history container was not found in time", {
      error: error.message,
      selector: selectors.chat.history,
    });

    return {
      sourceOpenChat: "",
      lastMessages: [],
      lastIncomingCandidateMessages: [],
      incomingDetectionMode: "history_not_found",
      messageTimeline: [],
      acceptButtonDetected: false,
    };
  }

  if (config.postOpenDelayMs > 0) {
    await sleep(config.postOpenDelayMs);
  }

  const messageSnapshot = await historyLocator.evaluate(
    (historyNode, payload) => {
      const cleanText = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim();

      const getJoinedText = (rootNode, selector) =>
        cleanText(
          Array.from(rootNode.querySelectorAll(selector))
            .map((node) => cleanText(node.textContent || ""))
            .filter(Boolean)
            .join(" "),
        );

      const getTimestampText = (itemNode, stackNode) => {
        const itemName = cleanText(itemNode.getAttribute("name"));
        if (itemName) {
          return itemName;
        }

        const itemInfoTitle = cleanText(
          itemNode.querySelector(".im-info")?.getAttribute("title"),
        );
        if (itemInfoTitle) {
          return itemInfoTitle;
        }

        return cleanText(
          stackNode.querySelector(".im-info")?.getAttribute("title"),
        );
      };

      const stackNodes = Array.from(historyNode.querySelectorAll(".im-stack"));
      const messageTimeline = [];
      const sourceBlocks = [];

      for (const stackNode of stackNodes) {
        const direction = stackNode.matches(".im-stack.im-stack-outgoing")
          ? "outgoing"
          : "incoming";
        const authorName = cleanText(
          stackNode.querySelector(".im-stack__info .im-stack__name")
            ?.textContent || "",
        );
        const sourceText = cleanText(
          stackNode.querySelector(".im-source-item")?.textContent || "",
        );
        const messageItems = Array.from(
          stackNode.querySelectorAll(".im-stack__messages-item"),
        );

        if (sourceText) {
          sourceBlocks.push(sourceText);
        }

        for (const itemNode of messageItems) {
          const textSelector =
            direction === "outgoing"
              ? ".im-message.im-message_out .im-message__text"
              : ".im-message .im-message__text";
          const text = getJoinedText(itemNode, textSelector);

          if (!text) {
            continue;
          }

          messageTimeline.push({
            direction,
            managerName: direction === "outgoing" ? authorName : "",
            authorName,
            text,
            timestampText: getTimestampText(itemNode, stackNode),
            sourceText,
          });
        }
      }

      return {
        sourceBlocks,
        lastMessages: messageTimeline
          .map((message) => message.text)
          .slice(-payload.maxLastMessages),
        lastIncomingCandidateMessages: messageTimeline
          .filter((message) => message.direction === "incoming")
          .map((message) => message.text)
          .slice(-payload.maxLastMessages),
        incomingDetectionMode: "stack_based",
        messageTimeline,
      };
    },
    {
      maxLastMessages: config.maxLastMessages,
    },
  );

  let lastMessages = (messageSnapshot.lastMessages || [])
    .map((item) => normalizeText(item))
    .filter(Boolean);
  let lastIncomingCandidateMessages = (
    messageSnapshot.lastIncomingCandidateMessages || []
  )
    .map((item) => normalizeText(item))
    .filter(Boolean);
  let incomingDetectionMode =
    messageSnapshot.incomingDetectionMode || "fallback_message_text_selector";
  let messageTimeline = Array.isArray(messageSnapshot.messageTimeline)
    ? messageSnapshot.messageTimeline
        .map((message) => ({
          direction: normalizeText(message.direction) || "unknown",
          managerName: normalizeText(message.managerName),
          authorName: normalizeText(message.authorName),
          text: normalizeText(message.text),
          timestampText: normalizeText(message.timestampText),
          sourceText: normalizeText(message.sourceText),
        }))
        .filter((message) => message.text)
    : [];

  if (!messageTimeline.length) {
    const fallbackMessages = await page
      .locator(selectors.chat.messageText)
      .evaluateAll((nodes, maxLastMessages) => {
        return nodes
          .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(-maxLastMessages);
      }, config.maxLastMessages);

    lastMessages = fallbackMessages
      .map((item) => normalizeText(item))
      .filter(Boolean);
    lastIncomingCandidateMessages = [];
    incomingDetectionMode = "fallback_message_text_selector";
    messageTimeline = lastMessages.map((text) => ({
      direction: "unknown",
      managerName: "",
      authorName: "",
      text,
      timestampText: "",
      sourceText: "",
    }));
  }

  const sourceBlocks = uniqueNonEmpty([
    ...(messageSnapshot.sourceBlocks || [])
      .map((item) => normalizeText(item))
      .filter(Boolean),
    ...(await page.locator(selectors.chat.source).evaluateAll((nodes) => {
      return nodes
        .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
    })),
  ]);
  const acceptButtonDetected =
    (await page.locator(selectors.acceptButton).count()) > 0;

  return {
    sourceOpenChat: normalizeText(sourceBlocks.join(" | ")),
    lastMessages,
    lastIncomingCandidateMessages,
    incomingDetectionMode,
    messageTimeline,
    acceptButtonDetected,
  };
}

module.exports = {
  readOpenChat,
};
