const selectors = require("./selectors");
const { buildComparableDealId, normalizeText } = require("./utils");

function extractDealRowData(rowElement, currentSelectors) {
  const cleanText = (node) =>
    ((node && node.textContent) || "").replace(/\s+/g, " ").trim();
  const previewBlocks = Array.from(
    rowElement.querySelectorAll(currentSelectors.preview.content),
  );
  const lastPreviewBlock = previewBlocks.length
    ? previewBlocks[previewBlocks.length - 1]
    : null;
  const previewTextNode = lastPreviewBlock
    ? lastPreviewBlock.querySelector(
        currentSelectors.preview.text || ".message-preview__text",
      )
    : null;

  return {
    href: (rowElement.getAttribute("href") || "").trim(),
    userName: cleanText(
      rowElement.querySelector(currentSelectors.preview.userName),
    ),
    timeText: cleanText(
      rowElement.querySelector(currentSelectors.preview.time),
    ),
    sourcePreview: cleanText(
      rowElement.querySelector(currentSelectors.preview.source),
    ),
    previewText: cleanText(previewTextNode || lastPreviewBlock),
  };
}

async function scanDealRows(page, logger, baseUrl) {
  const rowLocator = page.locator(selectors.dealRow);
  const rowCount = await rowLocator.count();

  if (!rowCount) {
    await logger.warn("No dialog rows found by selector a.deals-row");
    return [];
  }

  const rows = [];
  for (let index = 0; index < rowCount; index += 1) {
    try {
      const row = rowLocator.nth(index);
      const rawData = await row.evaluate(extractDealRowData, selectors);

      const dealId = buildComparableDealId(rawData.href, baseUrl);
      if (!dealId) {
        await logger.warn("Skipped dialog row without href", {
          rowIndex: index,
        });
        continue;
      }

      rows.push({
        index,
        dealId,
        userName: normalizeText(rawData.userName),
        previewText: normalizeText(rawData.previewText),
        sourcePreview: normalizeText(rawData.sourcePreview),
        timeText: normalizeText(rawData.timeText),
      });
    } catch (error) {
      await logger.warn("Failed to extract one dialog row", {
        rowIndex: index,
        error: error.message,
      });
    }
  }

  return rows;
}

async function openDeal(page, dealId, logger, config) {
  let targetUrl = "";

  try {
    targetUrl = new URL(dealId, config.url).toString();
  } catch (error) {
    await logger.warn("Failed to build absolute dialog URL", {
      dealId,
      baseUrl: config.url,
      error: error.message,
    });
    return false;
  }

  try {
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
    });
  } catch (error) {
    await logger.warn("Direct navigation to dialog failed", {
      dealId,
      targetUrl,
      error: error.message,
    });
    return false;
  }

  try {
    await page.locator(selectors.chat.history).waitFor({
      state: "visible",
      timeout: config.openChatTimeoutMs,
    });
    return true;
  } catch (error) {
    await logger.warn(
      "Dialog navigation completed but chat history did not appear",
      {
        dealId,
        targetUrl,
        selector: selectors.chat.history,
        timeoutMs: config.openChatTimeoutMs,
        error: error.message,
      },
    );
    return false;
  }
}

module.exports = {
  extractDealRowData,
  openDeal,
  scanDealRows,
};
