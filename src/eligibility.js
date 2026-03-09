const { normalizeText, toLowerNormalized } = require('./utils');

function parseShiftTime(value) {
  const match = normalizeText(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return { hour: 10, minute: 0 };
  }

  return {
    hour: Number(match[1]),
    minute: Number(match[2])
  };
}

function getZonedDateParts(timeZone, now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function compareDateParts(left, right) {
  const fields = ['year', 'month', 'day', 'hour', 'minute'];
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
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function buildTodayShiftBoundary(shiftRules, now = new Date()) {
  const timeZone = shiftRules?.timezone || 'UTC';
  const today = getZonedDateParts(timeZone, now);
  const shiftStart = parseShiftTime(shiftRules?.dayShiftStartsAt || '10:00');

  return {
    year: today.year,
    month: today.month,
    day: today.day,
    hour: shiftStart.hour,
    minute: shiftStart.minute
  };
}

function parseMessageTimestamp(timestampText, shiftRules, now = new Date()) {
  const raw = normalizeText(timestampText);
  if (!raw) {
    return null;
  }

  const lower = toLowerNormalized(raw);
  const timeZone = shiftRules?.timezone || 'UTC';
  const today = getZonedDateParts(timeZone, now);
  const yesterday = getZonedDateParts(timeZone, new Date(now.getTime() - (24 * 60 * 60 * 1000)));
  const timeMatch = lower.match(/(\d{1,2}):(\d{2})/);

  if (!timeMatch) {
    return null;
  }

  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);

  if (lower.includes('сегодня') || lower.includes('today')) {
    return {
      raw,
      year: today.year,
      month: today.month,
      day: today.day,
      hour,
      minute,
      source: 'relative_today'
    };
  }

  if (lower.includes('вчера') || lower.includes('yesterday')) {
    return {
      raw,
      year: yesterday.year,
      month: yesterday.month,
      day: yesterday.day,
      hour,
      minute,
      source: 'relative_yesterday'
    };
  }

  const isoMatch = lower.match(/(\d{4})[.-](\d{1,2})[.-](\d{1,2}).*?(\d{1,2}):(\d{2})/);
  if (isoMatch) {
    return {
      raw,
      year: Number(isoMatch[1]),
      month: Number(isoMatch[2]),
      day: Number(isoMatch[3]),
      hour: Number(isoMatch[4]),
      minute: Number(isoMatch[5]),
      source: 'iso_like'
    };
  }

  const localDateMatch = lower.match(/(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?.*?(\d{1,2}):(\d{2})/);
  if (localDateMatch) {
    const parsedYear = localDateMatch[3]
      ? Number(localDateMatch[3].length === 2 ? `20${localDateMatch[3]}` : localDateMatch[3])
      : today.year;

    return {
      raw,
      year: parsedYear,
      month: Number(localDateMatch[2]),
      day: Number(localDateMatch[1]),
      hour: Number(localDateMatch[4]),
      minute: Number(localDateMatch[5]),
      source: localDateMatch[3] ? 'date_time_with_year' : 'date_time_without_year'
    };
  }

  return {
    raw,
    year: today.year,
    month: today.month,
    day: today.day,
    hour,
    minute,
    source: 'time_only_assumed_today'
  };
}

function normalizeManagerName(value) {
  return toLowerNormalized(value).replace(/["'«»„“”]/g, '');
}

function matchConfiguredManager(managerName, managerList) {
  const normalizedTarget = normalizeManagerName(managerName);
  if (!normalizedTarget) {
    return '';
  }

  for (const candidate of managerList || []) {
    const normalizedCandidate = normalizeManagerName(candidate);
    if (!normalizedCandidate) {
      continue;
    }

    if (
      normalizedTarget === normalizedCandidate
      || normalizedTarget.includes(normalizedCandidate)
      || normalizedCandidate.includes(normalizedTarget)
    ) {
      return candidate;
    }
  }

  return '';
}

function evaluateChatEligibility(messageTimeline, shiftRules, now = new Date()) {
  if (!shiftRules?.enabled) {
    return {
      allowed: true,
      reason: 'shift_rules_disabled',
      matchedManager: '',
      matchedTimestamp: ''
    };
  }

  if (normalizeManagerName(shiftRules.myShift) !== 'day') {
    return {
      allowed: true,
      reason: 'current_shift_is_not_day',
      matchedManager: '',
      matchedTimestamp: ''
    };
  }

  const dayManagers = Array.isArray(shiftRules.dayManagers) ? shiftRules.dayManagers : [];
  if (!dayManagers.length) {
    return {
      allowed: true,
      reason: 'day_managers_not_configured',
      matchedManager: '',
      matchedTimestamp: ''
    };
  }

  const shiftBoundary = buildTodayShiftBoundary(shiftRules, now);
  const timeline = Array.isArray(messageTimeline) ? [...messageTimeline].reverse() : [];

  for (const message of timeline) {
    if (normalizeManagerName(message?.direction) !== 'outgoing') {
      continue;
    }

    const matchedManager = matchConfiguredManager(message?.managerName, dayManagers);
    if (!matchedManager) {
      continue;
    }

    const parsedTimestamp = parseMessageTimestamp(message?.timestampText, shiftRules, now);
    if (!parsedTimestamp) {
      continue;
    }

    if (!isSameLocalDate(parsedTimestamp, shiftBoundary)) {
      continue;
    }

    if (compareDateParts(parsedTimestamp, shiftBoundary) >= 0) {
      return {
        allowed: false,
        reason: 'day_manager_already_replied_today_after_shift_start',
        matchedManager,
        matchedTimestamp: normalizeText(message?.timestampText) || parsedTimestamp.raw
      };
    }
  }

  return {
    allowed: true,
    reason: 'no_day_manager_activity_after_shift_start',
    matchedManager: '',
    matchedTimestamp: ''
  };
}

module.exports = {
  evaluateChatEligibility,
  parseMessageTimestamp
};
