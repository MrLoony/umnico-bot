function createRuntimeState() {
  return {
    mode: 'IDLE',
    shouldExit: false,
    loopActive: false,
    browserReady: false,
    checked: 0,
    opened: 0,
    acceptedCandidates: 0,
    skipped: 0,
    strongNegativeSkipped: 0,
    lastAction: 'Waiting for browser and start command',
    recentEvents: []
  };
}

function setMode(state, mode) {
  state.mode = mode;
}

function setLastAction(state, lastAction) {
  state.lastAction = lastAction;
}

function increment(state, fieldName) {
  state[fieldName] = Number(state[fieldName] || 0) + 1;
}

function addEvent(state, eventText) {
  const stamp = new Date().toLocaleTimeString();
  state.recentEvents.push(`${stamp} ${eventText}`);
  if (state.recentEvents.length > 10) {
    state.recentEvents.shift();
  }
}

module.exports = {
  addEvent,
  createRuntimeState,
  increment,
  setLastAction,
  setMode
};
