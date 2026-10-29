// Date and time helpers. Everything shown to people is in India time (IST).
export const TZ = 'Asia/Kolkata';

const dateTimeFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: TZ,
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const dayFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: TZ,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

const longDayFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: TZ,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

export function formatIST(iso) {
  if (!iso) return '';
  return dateTimeFmt.format(new Date(iso)) + ' IST';
}

// "YYYY-MM-DD" -> "Mon, 3 Nov" (plain calendar dates, no time zone shift)
export function formatDay(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  return dayFmt.format(new Date(Date.UTC(y, m - 1, d, 6)));
}

export function formatLongToday(now = new Date()) {
  return longDayFmt.format(now);
}

// Today's calendar date in IST as "YYYY-MM-DD".
export function todayIST(now = new Date()) {
  return ymdInZone(now, TZ);
}

export function ymdInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Whole days from ymd a to ymd b.
export function daysBetween(a, b) {
  const toUTC = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUTC(b) - toUTC(a)) / 86400000);
}

export function ymdUTC(date) {
  return date.toISOString().slice(0, 10);
}
