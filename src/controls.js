const readline = require('node:readline');

function createControls(state, handlers) {
  let renderTimer = null;
  let keypressHandler = null;

  function render() {
    const lines = [
      'Umnico Diagnostic Bot',
      '',
      `State: ${state.mode}`,
      `Checked: ${state.checked}`,
      `Opened: ${state.opened}`,
      `AcceptedCandidates: ${state.acceptedCandidates}`,
      `Skipped: ${state.skipped}`,
      `StrongNegativeSkipped: ${state.strongNegativeSkipped}`,
      `LastAction: ${state.lastAction}`,
      '',
      'Hotkeys: s=start, p=pause, r=resume, t=stop, q=quit',
      '',
      'Recent events:'
    ];

    if (!state.recentEvents.length) {
      lines.push('- none');
    } else {
      for (const event of state.recentEvents) {
        lines.push(`- ${event}`);
      }
    }

    console.clear();
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  function startRendering() {
    render();
    renderTimer = setInterval(render, 500);
  }

  function stopRendering() {
    if (renderTimer) {
      clearInterval(renderTimer);
      renderTimer = null;
    }
  }

  async function onAction(handler) {
    try {
      await handler?.();
    } catch (error) {
      state.lastAction = `Hotkey handler failed: ${error.message}`;
    }
  }

  function attachKeyboard() {
    if (!process.stdin.isTTY) {
      state.lastAction = 'TTY was not detected, hotkeys are unavailable';
      return;
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    keypressHandler = async (_, key) => {
      if (!key) {
        return;
      }

      if (key.ctrl && key.name === 'c') {
        await onAction(handlers.quit);
        return;
      }

      switch (key.name) {
        case 's':
          await onAction(handlers.start);
          break;
        case 'p':
          await onAction(handlers.pause);
          break;
        case 'r':
          await onAction(handlers.resume);
          break;
        case 't':
          await onAction(handlers.stop);
          break;
        case 'q':
          await onAction(handlers.quit);
          break;
        default:
          break;
      }
    };

    process.stdin.on('keypress', keypressHandler);
  }

  function detachKeyboard() {
    if (keypressHandler) {
      process.stdin.off('keypress', keypressHandler);
      keypressHandler = null;
    }

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  }

  return {
    attach() {
      attachKeyboard();
      startRendering();
    },
    close() {
      stopRendering();
      detachKeyboard();
    },
    render
  };
}

module.exports = {
  createControls
};
