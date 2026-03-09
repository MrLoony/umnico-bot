const path = require("node:path");
const { chromium } = require("playwright");
const { readOpenChat } = require("./chatReader");
const { createControls } = require("./controls");
const { evaluateChatEligibility } = require("./eligibility");
const {
  buildFinalAssessment,
  buildPreliminaryAssessment,
} = require("./filter");
const { createLogger } = require("./logger");
const { openDeal, scanDealRows } = require("./scanner");
const {
  addEvent,
  createRuntimeState,
  increment,
  setLastAction,
  setMode,
} = require("./state");
const {
  ensureProjectFiles,
  loadConfig,
  loadSeenSet,
  saveSeenSet,
} = require("./storage");
const { nowIso, resolveProjectPath, sleep, truncate } = require("./utils");

const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = "config/config.json";
const SEEN_PATH = "data/seen.json";
const LOG_PATH = "logs/log.txt";

async function bootstrapBrowser(config, logger) {
  const userDataDir = resolveProjectPath(ROOT_DIR, config.browserUserDataDir);
  await logger.info("Launching persistent browser profile", {
    userDataDir,
    headless: config.headless,
  });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: Boolean(config.headless),
    viewport: null,
    args: ["--start-maximized"],
  });

  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(Math.max(config.openChatTimeoutMs, 5000));

  if (page.url() === "about:blank" && config.autoNavigateOnStart !== false) {
    try {
      await page.goto(config.url, {
        waitUntil: "domcontentloaded",
        timeout: config.initialGotoTimeoutMs,
      });
    } catch (error) {
      await logger.warn("Initial goto failed, continuing without fatal error", {
        url: config.url,
        timeoutMs: config.initialGotoTimeoutMs,
        error: error.message,
      });
    }
  } else if (page.url() === "about:blank") {
    await logger.info("Initial goto skipped because autoNavigateOnStart=false");
  }

  await logger.info(
    "Browser is ready. Log in manually and open the New dialogs tab before pressing s.",
  );
  return { context, page };
}

async function processDeal({ deal, page, state, config, logger, seenSet }) {
  increment(state, "checked");
  setLastAction(state, `Scoring ${deal.userName || deal.dealId}`);

  const preliminary = buildPreliminaryAssessment(deal, config);

  if (preliminary.decision === "SKIP_STRONG_NEGATIVE") {
    increment(state, "strongNegativeSkipped");
    await logger.logDecision({
      timestamp: nowIso(),
      dryRun: config.dryRun,
      dealId: deal.dealId,
      userName: deal.userName,
      previewText: deal.previewText,
      sourcePreview: deal.sourcePreview,
      sourceOpenChat: "",
      timeText: deal.timeText,
      lastMessages: [],
      lastIncomingCandidateMessages: [],
      preliminaryScore: preliminary.preliminaryScore,
      finalScore: preliminary.preliminaryScore,
      decision: "SKIP_STRONG_NEGATIVE",
      preliminaryHits: preliminary.preliminaryHits,
      finalHits: preliminary.preliminaryHits,
      acceptButtonDetected: false,
      eligibilityAllowed: true,
      eligibilityReason: "not_checked_preliminary_skip",
      matchedManager: "",
      matchedTimestamp: "",
      sourceModifierApplied: preliminary.sourceModifierApplied,
      note: "Skipped by preliminary score and explicit negative keywords",
    });
    seenSet.add(deal.dealId);
    await saveSeenSet(ROOT_DIR, SEEN_PATH, seenSet);
    return;
  }

  if (!preliminary.shouldOpen) {
    increment(state, "skipped");
    await logger.logDecision({
      timestamp: nowIso(),
      dryRun: config.dryRun,
      dealId: deal.dealId,
      userName: deal.userName,
      previewText: deal.previewText,
      sourcePreview: deal.sourcePreview,
      sourceOpenChat: "",
      timeText: deal.timeText,
      lastMessages: [],
      lastIncomingCandidateMessages: [],
      preliminaryScore: preliminary.preliminaryScore,
      finalScore: preliminary.preliminaryScore,
      decision: "SKIP",
      preliminaryHits: preliminary.preliminaryHits,
      finalHits: preliminary.preliminaryHits,
      acceptButtonDetected: false,
      eligibilityAllowed: true,
      eligibilityReason: "not_checked_preliminary_skip",
      matchedManager: "",
      matchedTimestamp: "",
      sourceModifierApplied: preliminary.sourceModifierApplied,
      note: "Low preliminary score, chat open was not needed",
    });
    seenSet.add(deal.dealId);
    await saveSeenSet(ROOT_DIR, SEEN_PATH, seenSet);
    return;
  }

  setLastAction(state, `Opening ${deal.userName || deal.dealId}`);
  const opened = await openDeal(page, deal.dealId, logger, config);
  if (!opened) {
    await logger.warn(
      "Opening failed, the dialog will be retried in the next cycle",
      { dealId: deal.dealId },
    );
    return;
  }

  increment(state, "opened");
  const chatSnapshot = await readOpenChat(page, logger, config);
  const finalAssessment = buildFinalAssessment(
    deal,
    chatSnapshot,
    config,
    preliminary,
  );
  const eligibility = evaluateChatEligibility(
    chatSnapshot.messageTimeline,
    config.shiftRules,
  );
  const effectiveDecision = eligibility.allowed
    ? finalAssessment.decision
    : "BLOCK_BY_SHIFT_RULE";

  if (effectiveDecision === "ACCEPT_CANDIDATE") {
    increment(state, "acceptedCandidates");
  } else if (effectiveDecision === "SKIP_STRONG_NEGATIVE") {
    increment(state, "strongNegativeSkipped");
  } else if (
    effectiveDecision === "SKIP" ||
    effectiveDecision === "BLOCK_BY_SHIFT_RULE"
  ) {
    increment(state, "skipped");
  }

  setLastAction(
    state,
    `${effectiveDecision} ${deal.userName || deal.dealId} (${finalAssessment.finalScore})`,
  );

  await logger.logDecision({
    timestamp: nowIso(),
    dryRun: config.dryRun,
    dealId: deal.dealId,
    userName: deal.userName,
    previewText: deal.previewText,
    sourcePreview: deal.sourcePreview,
    sourceOpenChat: chatSnapshot.sourceOpenChat,
    timeText: deal.timeText,
    lastMessages: chatSnapshot.lastMessages,
    lastIncomingCandidateMessages: chatSnapshot.lastIncomingCandidateMessages,
    incomingDetectionMode: chatSnapshot.incomingDetectionMode,
    scoringMessageBasis: finalAssessment.scoringMessageBasis,
    scoringMessagesUsed: finalAssessment.scoringMessagesUsed,
    preliminaryScore: preliminary.preliminaryScore,
    finalScore: finalAssessment.finalScore,
    decision: effectiveDecision,
    preliminaryHits: preliminary.preliminaryHits,
    finalHits: finalAssessment.finalHits,
    acceptButtonDetected: chatSnapshot.acceptButtonDetected,
    eligibilityAllowed: eligibility.allowed,
    eligibilityReason: eligibility.reason,
    matchedManager: eligibility.matchedManager,
    matchedTimestamp: eligibility.matchedTimestamp,
    sourceModifierApplied: finalAssessment.sourceModifierApplied,
    note: !eligibility.allowed
      ? `Blocked by shift rule: ${eligibility.reason}`
      : chatSnapshot.acceptButtonDetected
        ? "Accept button detected but intentionally not clicked in dry-run diagnostics"
        : "Accept button not detected",
  });

  seenSet.add(deal.dealId);
  await saveSeenSet(ROOT_DIR, SEEN_PATH, seenSet);
}

async function scanLoop({ page, state, config, logger, seenSet }) {
  if (state.loopActive) {
    return;
  }

  state.loopActive = true;

  while (!state.shouldExit) {
    if (state.mode !== "RUNNING") {
      await sleep(250);
      continue;
    }

    try {
      const deals = await scanDealRows(page, logger, config.url);
      if (!deals.length) {
        setLastAction(state, "No new rows detected in current view");
      }

      for (const deal of deals) {
        if (state.shouldExit || state.mode !== "RUNNING") {
          break;
        }

        if (seenSet.has(deal.dealId)) {
          continue;
        }

        try {
          await processDeal({ deal, page, state, config, logger, seenSet });
        } catch (error) {
          await logger.error(
            "Deal processing failed, continuing with next dialog",
            {
              dealId: deal.dealId,
              error: error.message,
              userName: deal.userName,
              previewText: truncate(deal.previewText),
            },
          );
          setLastAction(state, `Error on ${deal.userName || deal.dealId}`);
        }

        if (config.betweenDealsDelayMs > 0) {
          await sleep(config.betweenDealsDelayMs);
        }
      }
    } catch (error) {
      await logger.error("Cycle failed, continuing after delay", {
        error: error.message,
      });
      setLastAction(state, `Cycle error: ${error.message}`);
    }

    await sleep(config.pollIntervalMs);
  }

  state.loopActive = false;
}

async function main() {
  await ensureProjectFiles(ROOT_DIR);
  const config = await loadConfig(ROOT_DIR, CONFIG_PATH);
  const seenSet = await loadSeenSet(ROOT_DIR, SEEN_PATH);
  const state = createRuntimeState();
  const logger = createLogger({
    logPath: resolveProjectPath(ROOT_DIR, LOG_PATH),
    onEvent: (message) => addEvent(state, message),
  });

  let browserContext = null;
  let controls = null;

  const shutdown = async () => {
    if (state.shouldExit) {
      return;
    }

    state.shouldExit = true;
    setMode(state, "STOPPED");
    setLastAction(state, "Shutting down");

    await logger.info("Shutdown requested");

    if (controls) {
      controls.close();
    }

    if (browserContext) {
      await browserContext.close();
    }
  };

  try {
    const browser = await bootstrapBrowser(config, logger);
    browserContext = browser.context;
    state.browserReady = true;
    setLastAction(state, "Ready. Log in manually, open New, press s to start");

    const handlers = {
      start: async () => {
        if (!state.browserReady) {
          setLastAction(state, "Browser is not ready yet");
          return;
        }

        if (state.mode === "RUNNING") {
          setLastAction(state, "Already running");
          return;
        }

        setMode(state, "RUNNING");
        setLastAction(state, "Scanning started");
        await logger.info("Scanning started");
      },
      pause: async () => {
        if (state.mode !== "RUNNING") {
          setLastAction(state, "Pause ignored: bot is not running");
          return;
        }

        setMode(state, "PAUSED");
        setLastAction(state, "Scanning paused");
        await logger.info("Scanning paused");
      },
      resume: async () => {
        if (state.mode === "RUNNING") {
          setLastAction(state, "Already running");
          return;
        }

        setMode(state, "RUNNING");
        setLastAction(state, "Scanning resumed");
        await logger.info("Scanning resumed");
      },
      stop: async () => {
        setMode(state, "STOPPED");
        setLastAction(state, "Scanning stopped");
        await logger.info("Scanning stopped");
      },
      quit: async () => {
        await shutdown();
      },
    };

    controls = createControls(state, handlers);
    controls.attach();
    scanLoop({ page: browser.page, state, config, logger, seenSet }).catch(
      async (error) => {
        await logger.error("Background scan loop crashed", {
          error: error.message,
        });
        await shutdown();
      },
    );

    process.on("SIGINT", async () => {
      await shutdown();
    });

    process.on("SIGTERM", async () => {
      await shutdown();
    });

    process.on("uncaughtException", async (error) => {
      await logger.error("Uncaught exception", {
        error: error.message,
        stack: error.stack,
      });
      await shutdown();
    });

    process.on("unhandledRejection", async (reason) => {
      await logger.error("Unhandled rejection", {
        error: reason instanceof Error ? reason.message : String(reason),
      });
      await shutdown();
    });

    while (!state.shouldExit) {
      await sleep(250);
    }
  } finally {
    if (controls) {
      controls.close();
    }

    if (browserContext) {
      await browserContext.close().catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exitCode = 1;
});
