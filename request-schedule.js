'use strict';

const DEFAULT_REQUEST_TIMEZONE = 'Asia/Jakarta';
const DEFAULT_REQUEST_SCHEDULE = Object.freeze({
  enabled: false,
  startTime: '09:00',
  endTime: '22:00'
});

function isValidTime(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hours, minutes] = value.split(':').map(Number);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function timeToMinutes(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return (hours * 60) + minutes;
}

function normalizeRequestSchedule(value) {
  const source = value && typeof value === 'object' ? value : {};
  const startTime = isValidTime(source.startTime)
    ? source.startTime
    : DEFAULT_REQUEST_SCHEDULE.startTime;
  const endTime = isValidTime(source.endTime)
    ? source.endTime
    : DEFAULT_REQUEST_SCHEDULE.endTime;

  return {
    enabled: source.enabled === true || source.enabled === 'true' || source.enabled === 1,
    startTime,
    endTime
  };
}

function validateRequestSchedule(value) {
  if (!value || typeof value !== 'object') {
    return { ok: false, message: 'Pengaturan jadwal wajib diisi' };
  }
  if (!isValidTime(value.startTime) || !isValidTime(value.endTime)) {
    return { ok: false, message: 'Jam mulai dan selesai harus memakai format HH:mm' };
  }
  if (value.startTime === value.endTime) {
    return { ok: false, message: 'Jam mulai dan selesai tidak boleh sama' };
  }
  return { ok: true };
}

function getMinutesInTimeZone(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  return (hour * 60) + minute;
}

function resolveTimeZone(value) {
  const candidate = typeof value === 'string' && value.trim()
    ? value.trim()
    : DEFAULT_REQUEST_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch (_) {
    return DEFAULT_REQUEST_TIMEZONE;
  }
}

function getRequestScheduleStatus(scheduleInput, options = {}) {
  const schedule = normalizeRequestSchedule(scheduleInput);
  const timeZone = resolveTimeZone(options.timeZone);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());

  if (!schedule.enabled) {
    return {
      ...schedule,
      timeZone,
      isOpen: true,
      crossesMidnight: false,
      nextOpenTime: null
    };
  }

  const currentMinutes = getMinutesInTimeZone(now, timeZone);
  const startMinutes = timeToMinutes(schedule.startTime);
  const endMinutes = timeToMinutes(schedule.endTime);
  const crossesMidnight = startMinutes > endMinutes;
  const isOpen = crossesMidnight
    ? currentMinutes >= startMinutes || currentMinutes < endMinutes
    : currentMinutes >= startMinutes && currentMinutes < endMinutes;

  return {
    ...schedule,
    timeZone,
    isOpen,
    crossesMidnight,
    nextOpenTime: isOpen ? null : schedule.startTime
  };
}

module.exports = {
  DEFAULT_REQUEST_SCHEDULE,
  DEFAULT_REQUEST_TIMEZONE,
  getRequestScheduleStatus,
  isValidTime,
  normalizeRequestSchedule,
  resolveTimeZone,
  validateRequestSchedule
};
