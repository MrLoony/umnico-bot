const path = require("node:path");
const { spawn } = require("node:child_process");
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
  loadWatchlist,
  saveSeenSet,
  saveWatchlist,
} = require("./storage");
const { nowIso, resolveProjectPath, sleep, truncate } = require("./utils");
const {
  buildWatchlistEntry,
  getWatchDecisionContext,
  isWatchlistEntryExpired,
  shouldRecheckWatchEntry,
} = require("./watchlist");

const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = "config/config.json";
const SEEN_PATH = "data/seen.json";
const WATCHLIST_PATH = "data/watchlist.json";
const LOG_PATH = "logs/log.txt";
const WATCH_DECISION = "WATCH_RECHECK";
const WATCHLIST_EXPIRED_REASON = "watchlist_expired";
const PRELIMINARY_SKIP_OWNERSHIP_DECISION = "NOT_CHECKED_PRELIMINARY_SKIP";
const PRELIMINARY_SKIP_OWNERSHIP_REASON = "not_checked_preliminary_skip";
const SOUND_COMMAND_TIMEOUT_MS = 1200;

function createOwnershipBypassAssessment() {
  return {
    decision: "",
    finalScore: null,
    scoringMessageBasis: "ownership_rule_bypass",
    scoringMessagesUsed: [],
    combinedText: "",
    sourceModifierApplied: false,
    finalHits: [],
  };
}

function createPreliminaryFinalAssessment(preliminary, decision) {
  return {
    decision,
    finalScore: preliminary.preliminaryScore,
    scoringMessageBasis: "preview_only",
    scoringMessagesUsed: [],
    combinedText: "",
    sourceModifierApplied: preliminary.sourceModifierApplied,
    finalHits: preliminary.preliminaryHits,
  };
}

function createEmptyChatSnapshot() {
  return {
    sourceOpenChat: "",
    lastMessages: [],
    lastIncomingCandidateMessages: [],
    incomingDetectionMode: "not_opened",
    messageTimeline: [],
    acceptButtonDetected: false,
  };
}

function createEligibilityStub({
  ownershipDecision = PRELIMINARY_SKIP_OWNERSHIP_DECISION,
  reason = PRELIMINARY_SKIP_OWNERSHIP_REASON,
  allowed = true,
} = {}) {
  return {
    allowed,
    reason,
    ownershipDecision,
    matchedManager: "",
    matchedTimestamp: "",
    lastOutgoingMessage: null,
  };
}

function createExpirationAssessments() {
  return {
    preliminary: {
      decision: "SKIP",
      preliminaryScore: null,
      preliminaryHits: [],
      sourceModifierApplied: false,
      shouldOpen: false,
    },
    finalAssessment: {
      decision: "SKIP",
      finalScore: null,
      scoringMessageBasis: "watchlist_expired",
      scoringMessagesUsed: [],
      combinedText: "",
      sourceModifierApplied: false,
      finalHits: [],
    },
  };
}

function getScoreSuffix(finalAssessment) {
  return finalAssessment.finalScore === null ||
    finalAssessment.finalScore === undefined
    ? ""
    : ` (${finalAssessment.finalScore})`;
}

function buildDecisionLogPayload({
  deal,
  config,
  preliminary,
  finalAssessment,
  chatSnapshot,
  eligibility,
  decision,
  scoringBypassed,
  note,
  watchlistStatus = "",
  watchReason = "",
  recheckAfterSeconds = null,
  retryCount = null,
  acceptClicked = false,
  acceptClickReason = null,
}) {
  const ownershipDecision =
    eligibility?.ownershipDecision || PRELIMINARY_SKIP_OWNERSHIP_DECISION;

  return {
    timestamp: nowIso(),
    dryRun: config.dryRun,
    dealId: deal.dealId,
    userName: deal.userName || "",
    previewText: deal.previewText || "",
    sourcePreview: deal.sourcePreview || "",
    sourceOpenChat: chatSnapshot.sourceOpenChat,
    timeText: deal.timeText || "",
    lastMessages: chatSnapshot.lastMessages,
    lastIncomingCandidateMessages: chatSnapshot.lastIncomingCandidateMessages,
    incomingDetectionMode: chatSnapshot.incomingDetectionMode,
    scoringMessageBasis: finalAssessment.scoringMessageBasis,
    scoringMessagesUsed: finalAssessment.scoringMessagesUsed,
    combinedText: finalAssessment.combinedText,
    preliminaryScore: preliminary.preliminaryScore,
    finalScore: finalAssessment.finalScore,
    decision,
    preliminaryHits: preliminary.preliminaryHits,
    finalHits: finalAssessment.finalHits,
    acceptButtonDetected: chatSnapshot.acceptButtonDetected,
    ownershipDecision,
    ownershipReason: eligibility.reason,
    eligibilityAllowed: eligibility.allowed,
    eligibilityReason: eligibility.reason,
    matchedManager: eligibility.matchedManager,
    matchedTimestamp: eligibility.matchedTimestamp,
    lastOutgoingManagerMessage: eligibility.lastOutgoingMessage,
    scoringBypassed,
    sourceModifierApplied: finalAssessment.sourceModifierApplied,
    note,
    watchlistStatus,
    watchReason,
    recheckAfterSeconds,
    retryCount,
    acceptClicked,
    acceptClickReason,
  };
}

function updateStateForDecision(state, decision) {
  if (
    decision === "ACCEPT_CANDIDATE" ||
    decision === "FORCE_ACCEPT_SELF_CHAT"
  ) {
    increment(state, "acceptedCandidates");
    return;
  }

  if (decision === "SKIP_STRONG_NEGATIVE") {
    increment(state, "strongNegativeSkipped");
    return;
  }

  if (decision === "SKIP" || decision === "BLOCK_BY_OWNER_RULE") {
    increment(state, "skipped");
  }
}

async function tryAcceptChat(page, logger, config) {
  if (config.dryRun) {
    await logger.info("DRY RUN: accept click skipped");
    return { clicked: false, reason: "dry_run" };
  }

  const acceptButtonTimeoutMs = Number.isFinite(
    Number(config.acceptButtonTimeoutMs),
  )
    ? Number(config.acceptButtonTimeoutMs)
    : 4000;
  const button = page.locator("#messaging-accept-dialog").first();

  try {
    await button.waitFor({
      state: "visible",
      timeout: acceptButtonTimeoutMs,
    });
  } catch (error) {
    await logger.warn("Accept button not found after wait", {
      timeoutMs: acceptButtonTimeoutMs,
      error: error.message,
    });
    return { clicked: false, reason: "not_found_after_wait" };
  }

  try {
    await button.click({ timeout: 2000 });
    await logger.info("Accept button clicked");

    return { clicked: true };
  } catch (error) {
    await logger.error("Accept click failed", {
      error: error.message,
    });

    return { clicked: false, reason: "click_failed" };
  }
}

function runSoundCommand(command, args, timeoutMs = SOUND_COMMAND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    let timeoutId = null;

    const finish = (played) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve(played);
    };

    try {
      child = spawn(command, args, {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (_) {
      finish(false);
      return;
    }

    timeoutId = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {}
      finish(false);
    }, timeoutMs);

    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

function getSoundBackends(platform) {
  if (platform === "win32") {
    return [
      {
        name: "powershell_console_beep",
        command: "powershell",
        args: ["-c", "[console]::beep(1000,300)"],
      },
      {
        name: "powershell_system_asterisk",
        command: "powershell",
        args: ["-c", "[System.Media.SystemSounds]::Asterisk.Play()"],
      },
    ];
  }

  if (platform === "darwin") {
    return [
      {
        name: "afplay_glass",
        command: "afplay",
        args: ["/System/Library/Sounds/Glass.aiff"],
      },
    ];
  }

  return [
    {
      name: "paplay_message",
      command: "paplay",
      args: ["/usr/share/sounds/freedesktop/stereo/message.oga"],
    },
    {
      name: "canberra_message",
      command: "canberra-gtk-play",
      args: ["-i", "message"],
    },
    {
      name: "aplay_front_center",
      command: "aplay",
      args: ["/usr/share/sounds/alsa/Front_Center.wav"],
    },
  ];
}

async function playAcceptSound(logger, config) {
  if (config.soundNotificationEnabled !== true) {
    return { soundPlayed: false, soundBackend: null };
  }

  const soundNotificationMode =
    typeof config.soundNotificationMode === "string" &&
    config.soundNotificationMode.trim()
      ? config.soundNotificationMode.trim().toLowerCase()
      : "auto";
  const backends =
    soundNotificationMode === "auto"
      ? getSoundBackends(process.platform)
      : getSoundBackends(process.platform);

  for (const backend of backends) {
    try {
      const played = await runSoundCommand(backend.command, backend.args);
      if (!played) {
        continue;
      }

      try {
        await logger.info("Accept sound notification completed", {
          soundPlayed: true,
          soundBackend: backend.name,
        });
      } catch (_) {}

      return { soundPlayed: true, soundBackend: backend.name };
    } catch (_) {
      continue;
    }
  }

  let soundPlayed = false;
  try {
    process.stdout.write("\x07");
    soundPlayed = true;
  } catch (_) {}

  try {
    await logger.info("Accept sound notification completed", {
      soundPlayed,
      soundBackend: "fallback_bell",
    });
  } catch (_) {}

  return {
    soundPlayed,
    soundBackend: "fallback_bell",
  };
}

async function markDealProcessed(dealId, seenSet, watchlist) {
  const hadWatchlistEntry = Object.prototype.hasOwnProperty.call(
    watchlist,
    dealId,
  );

  seenSet.add(dealId);
  if (hadWatchlistEntry) {
    delete watchlist[dealId];
  }

  await saveSeenSet(ROOT_DIR, SEEN_PATH, seenSet);
  if (hadWatchlistEntry) {
    await saveWatchlist(ROOT_DIR, WATCHLIST_PATH, watchlist);
  }
}

async function scheduleDealWatch(dealId, watchlist, entry) {
  watchlist[dealId] = entry;
  await saveWatchlist(ROOT_DIR, WATCHLIST_PATH, watchlist);
}

async function commitDecision({
  deal,
  page,
  state,
  config,
  logger,
  seenSet,
  watchlist,
  preliminary,
  finalAssessment,
  chatSnapshot,
  eligibility,
  decision,
  scoringBypassed,
  note,
}) {
  let effectiveDecision = decision;
  let effectiveNote = note;
  let watchlistStatus = "";
  let watchReason = "";
  let recheckAfterSeconds = null;
  let retryCount = null;
  let watchlistEntry = null;
  let acceptResult = { clicked: false };

  if (decision === "SKIP" && config.watchlist.enabled) {
    const watchContext = getWatchDecisionContext(
      deal,
      preliminary,
      chatSnapshot,
      { ...finalAssessment, decision },
      eligibility,
    );

    if (watchContext.shouldWatch) {
      const existingEntry = watchlist[deal.dealId];
      const nextRetryCount = Number(existingEntry?.retryCount || 0) + 1;

      if (nextRetryCount > config.watchlist.maxRetries) {
        watchlistStatus = "expired";
        watchReason = WATCHLIST_EXPIRED_REASON;
        retryCount = Number(existingEntry?.retryCount || 0);
        effectiveNote =
          "Watchlist entry expired after reaching the retry limit";
      } else {
        effectiveDecision = WATCH_DECISION;
        watchlistEntry = buildWatchlistEntry({
          existingEntry,
          deal,
          now: new Date(),
          ttlMinutes: config.watchlist.ttlMinutes,
          reason: watchContext.reason,
        });
        watchlistStatus = "scheduled";
        watchReason = watchContext.reason;
        recheckAfterSeconds = config.watchlist.cooldownSeconds;
        retryCount = watchlistEntry.retryCount;
        effectiveNote =
          "Weak greeting-like chat was scheduled for cooldown-based recheck";
      }
    }
  }

  if (
    effectiveDecision === "ACCEPT_CANDIDATE" ||
    effectiveDecision === "FORCE_ACCEPT_SELF_CHAT"
  ) {
    acceptResult = await tryAcceptChat(page, logger, config);

    if (acceptResult.clicked) {
      await playAcceptSound(logger, config);

      if (config.postAcceptDelayMs > 0) {
        await logger.info("Waiting after accept click", {
          delayMs: config.postAcceptDelayMs,
        });
        await sleep(config.postAcceptDelayMs);
      }
    }
  }

  updateStateForDecision(state, effectiveDecision);
  setLastAction(
    state,
    `${effectiveDecision} ${deal.userName || deal.dealId}${getScoreSuffix(finalAssessment)}`,
  );

  await logger.logDecision(
    buildDecisionLogPayload({
      deal,
      config,
      preliminary,
      finalAssessment,
      chatSnapshot,
      eligibility,
      decision: effectiveDecision,
      scoringBypassed,
      note: effectiveNote,
      watchlistStatus,
      watchReason,
      recheckAfterSeconds,
      retryCount,
      acceptClicked: acceptResult.clicked,
      acceptClickReason: acceptResult.reason || null,
    }),
  );

  if (effectiveDecision === WATCH_DECISION) {
    await scheduleDealWatch(deal.dealId, watchlist, watchlistEntry);
    return;
  }

  await markDealProcessed(deal.dealId, seenSet, watchlist);
}

async function expireWatchlistEntry({
  dealId,
  entry,
  visibleDeal,
  state,
  config,
  logger,
  seenSet,
  watchlist,
}) {
  const deal = {
    dealId,
    userName: visibleDeal?.userName || "",
    previewText: visibleDeal?.previewText || entry?.lastPreviewText || "",
    sourcePreview: visibleDeal?.sourcePreview || "",
    timeText: visibleDeal?.timeText || entry?.lastTimeText || "",
  };
  const { preliminary, finalAssessment } = createExpirationAssessments();

  updateStateForDecision(state, "SKIP");
  setLastAction(
    state,
    `SKIP ${deal.userName || deal.dealId} (watchlist expired)`,
  );

  await logger.logDecision(
    buildDecisionLogPayload({
      deal,
      config,
      preliminary,
      finalAssessment,
      chatSnapshot: createEmptyChatSnapshot(),
      eligibility: createEligibilityStub({
        ownershipDecision: "WATCHLIST_EXPIRED",
        reason: WATCHLIST_EXPIRED_REASON,
      }),
      decision: "SKIP",
      scoringBypassed: false,
      note: "Watchlist entry expired before a stronger lead signal arrived",
      watchlistStatus: "expired",
      watchReason: WATCHLIST_EXPIRED_REASON,
      recheckAfterSeconds: 0,
      retryCount: Number(entry?.retryCount || 0),
    }),
  );

  await markDealProcessed(dealId, seenSet, watchlist);
}

async function expireWatchlistEntries({
  visibleDealsById,
  state,
  config,
  logger,
  seenSet,
  watchlist,
}) {
  const now = new Date();

  for (const [dealId, entry] of Object.entries(watchlist)) {
    const expirationState = isWatchlistEntryExpired(
      entry,
      config.watchlist,
      now,
    );
    if (!expirationState.expiredByTime && !expirationState.expiredByRetries) {
      continue;
    }

    await expireWatchlistEntry({
      dealId,
      entry,
      visibleDeal: visibleDealsById.get(dealId),
      state,
      config,
      logger,
      seenSet,
      watchlist,
    });
  }
}

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

async function processDeal({
  deal,
  page,
  state,
  config,
  logger,
  seenSet,
  watchlist,
}) {
  increment(state, "checked");
  setLastAction(state, `Scoring ${deal.userName || deal.dealId}`);

  const preliminary = buildPreliminaryAssessment(deal, config);

  if (preliminary.decision === "SKIP_STRONG_NEGATIVE") {
    await commitDecision({
      deal,
      page,
      state,
      config,
      logger,
      seenSet,
      watchlist,
      preliminary,
      finalAssessment: createPreliminaryFinalAssessment(
        preliminary,
        "SKIP_STRONG_NEGATIVE",
      ),
      chatSnapshot: createEmptyChatSnapshot(),
      eligibility: createEligibilityStub(),
      decision: "SKIP_STRONG_NEGATIVE",
      scoringBypassed: false,
      note: "Skipped by preliminary score and explicit negative keywords",
    });
    return;
  }

  if (!preliminary.shouldOpen) {
    await commitDecision({
      deal,
      page,
      state,
      config,
      logger,
      seenSet,
      watchlist,
      preliminary,
      finalAssessment: createPreliminaryFinalAssessment(preliminary, "SKIP"),
      chatSnapshot: createEmptyChatSnapshot(),
      eligibility: createEligibilityStub(),
      decision: "SKIP",
      scoringBypassed: false,
      note: "Low preliminary score, chat open was not needed",
    });
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
  const eligibility = evaluateChatEligibility(
    chatSnapshot.messageTimeline,
    chatSnapshot.sourceOpenChat,
    config.ownershipRules,
  );
  const ownershipDecision = eligibility.ownershipDecision || "ALLOW_NORMAL";

  let finalAssessment = createOwnershipBypassAssessment();
  let effectiveDecision = "";
  let scoringBypassed = false;
  let note = "";

  if (ownershipDecision === "ALLOW_FORCE_SELF") {
    scoringBypassed = true;
    effectiveDecision = "FORCE_ACCEPT_SELF_CHAT";
    note =
      "Force-accepted by ownership rule because the latest outgoing message after boundary belongs to current user";
  } else if (ownershipDecision === "BLOCK_BY_OWNER_RULE") {
    scoringBypassed = true;
    effectiveDecision = "BLOCK_BY_OWNER_RULE";
    note =
      eligibility.reason ===
      "ownership_indeterminate_but_foreign_outgoing_markers_present"
        ? "Blocked by ownership rule because ownership is indeterminate and sourceOpenChat contains foreign outgoing manager markers"
        : "Blocked by ownership rule because the latest outgoing message after boundary belongs to another manager";
  } else {
    finalAssessment = buildFinalAssessment(
      deal,
      chatSnapshot,
      config,
      preliminary,
    );
    effectiveDecision = finalAssessment.decision;
    note = chatSnapshot.acceptButtonDetected
      ? "Accept button detected during chat scan"
      : "Accept button not detected during chat scan";
  }

  await commitDecision({
    deal,
    page,
    state,
    config,
    logger,
    seenSet,
    watchlist,
    preliminary,
    finalAssessment,
    chatSnapshot,
    eligibility,
    decision: effectiveDecision,
    scoringBypassed,
    note,
  });
}

async function scanLoop({ page, state, config, logger, seenSet, watchlist }) {
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
      const visibleDealsById = new Map(
        deals.map((deal) => [deal.dealId, deal]),
      );

      await expireWatchlistEntries({
        visibleDealsById,
        state,
        config,
        logger,
        seenSet,
        watchlist,
      });

      if (!deals.length) {
        if (!state.dialogListEmpty) {
          state.dialogListEmpty = true;
          await logger.info("Dialog list is empty");
        }
        setLastAction(state, "No new rows detected in current view");
      } else if (state.dialogListEmpty) {
        state.dialogListEmpty = false;
      }

      for (const deal of deals) {
        if (state.shouldExit || state.mode !== "RUNNING") {
          break;
        }

        if (seenSet.has(deal.dealId)) {
          continue;
        }

        const watchlistEntry = watchlist[deal.dealId];
        if (watchlistEntry && config.watchlist.enabled) {
          const recheckState = shouldRecheckWatchEntry(
            watchlistEntry,
            deal,
            config.watchlist.cooldownSeconds,
          );

          if (!recheckState.shouldRecheck) {
            continue;
          }
        }

        try {
          await processDeal({
            deal,
            page,
            state,
            config,
            logger,
            seenSet,
            watchlist,
          });
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
  const watchlist = await loadWatchlist(ROOT_DIR, WATCHLIST_PATH);
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
    scanLoop({
      page: browser.page,
      state,
      config,
      logger,
      seenSet,
      watchlist,
    }).catch(async (error) => {
      await logger.error("Background scan loop crashed", {
        error: error.message,
      });
      await shutdown();
    });

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
