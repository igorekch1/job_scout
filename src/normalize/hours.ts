/** Stated working hours such as "9am-5pm PST", and how they land in the user's time zone. */

export interface HoursRange {
  /** Minutes after midnight in the posting's own time zone. */
  startMinutes: number;
  endMinutes: number;
  /** Zone label as written, e.g. "PST" or "UTC-5". */
  zone: string;
  /** Offset of that zone from UTC in minutes (east is positive) on the reference date. */
  offsetMinutes: number;
  text: string;
}

const ZONES: Readonly<Record<string, string>> = {
  PT: 'America/Los_Angeles',
  PST: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
  PACIFIC: 'America/Los_Angeles',
  MT: 'America/Denver',
  MST: 'America/Denver',
  MDT: 'America/Denver',
  MOUNTAIN: 'America/Denver',
  CT: 'America/Chicago',
  CST: 'America/Chicago',
  CDT: 'America/Chicago',
  CENTRAL: 'America/Chicago',
  ET: 'America/New_York',
  EST: 'America/New_York',
  EDT: 'America/New_York',
  EASTERN: 'America/New_York',
  GMT: 'UTC',
  UTC: 'UTC',
  WET: 'Europe/Lisbon',
  BST: 'Europe/London',
  CET: 'Europe/Berlin',
  CEST: 'Europe/Berlin',
  EET: 'Europe/Helsinki',
  EEST: 'Europe/Helsinki',
  IST: 'Asia/Kolkata',
  SGT: 'Asia/Singapore',
  JST: 'Asia/Tokyo',
  AEST: 'Australia/Sydney',
  AEDT: 'Australia/Sydney',
};

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Offset of an IANA zone from UTC, in minutes, at the given instant. */
export function zoneOffsetMinutes(zone: string, at: Date): number {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(at)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

const MERIDIEM = '(a\\.?m\\.?|p\\.?m\\.?)';
const TIME = `(\\d{1,2})(?:[:.](\\d{2}))?\\s?${MERIDIEM}?`;
const ZONE = `((?:UTC|GMT)\\s?[+-]\\s?\\d{1,2}(?::\\d{2})?|(?:Pacific|Mountain|Central|Eastern)(?:\\s(?:Standard|Daylight))?\\sTime|${Object.keys(
  ZONES,
)
  .filter((key) => key.length <= 4)
  .sort((a, b) => b.length - a.length)
  .join('|')})`;
const RANGE = new RegExp(
  `${TIME}\\s?(?:-|–|—|to|until|till)\\s?${TIME}\\s?\\(?\\s?${ZONE}(?![A-Za-z])`,
  'gi',
);

type Meridiem = 'am' | 'pm' | null;

const toMeridiem = (token: string | undefined): Meridiem =>
  token ? (token.toLowerCase().startsWith('a') ? 'am' : 'pm') : null;

function to24(hour: number, meridiem: Meridiem): number {
  if (meridiem === 'am') return hour === 12 ? 0 : hour;
  if (meridiem === 'pm') return hour === 12 ? 12 : hour + 12;
  return hour;
}

function resolveZone(label: string, at: Date): number | null {
  const fixed = /^(?:UTC|GMT)\s?([+-])\s?(\d{1,2})(?::(\d{2}))?$/i.exec(label);
  if (fixed) {
    const minutes = Number(fixed[2]) * 60 + Number(fixed[3] ?? 0);
    return fixed[1] === '-' ? -minutes : minutes;
  }
  const key = label.split(/\s/)[0]!.toUpperCase();
  const zone = ZONES[key];
  return zone ? zoneOffsetMinutes(zone, at) : null;
}

/** Finds every "start-end ZONE" range in the text. */
export function parseHoursRanges(text: string, at: Date = new Date()): HoursRange[] {
  const ranges: HoursRange[] = [];

  for (const match of text.matchAll(RANGE)) {
    const [whole, h1, m1, mer1, h2, m2, mer2, zoneLabel] = match;
    if (!h1 || !h2 || !zoneLabel) continue;
    let startHour = Number(h1);
    let endHour = Number(h2);
    if (startHour > 23 || endHour > 23) continue;

    const startMeridiem = toMeridiem(mer1);
    const endMeridiem = toMeridiem(mer2);

    if (startMeridiem || endMeridiem) {
      if (startHour > 12 || endHour > 12) continue;
      endHour = to24(endHour, endMeridiem ?? startMeridiem);
      if (startMeridiem) {
        startHour = to24(startHour, startMeridiem);
      } else {
        // "9-5pm": the start shares the meridiem unless that would put it after the end
        const same = to24(startHour, endMeridiem);
        startHour = same > endHour ? to24(startHour, endMeridiem === 'pm' ? 'am' : 'pm') : same;
      }
    } else if (m1 === undefined && m2 === undefined) {
      // bare "9-5": only the conventional office-hours reading is safe
      if (!(startHour >= 6 && startHour <= 11 && endHour >= 1 && endHour <= 8)) continue;
      endHour += 12;
    }

    const offsetMinutes = resolveZone(zoneLabel, at);
    if (offsetMinutes === null) continue;

    ranges.push({
      startMinutes: startHour * 60 + Number(m1 ?? 0),
      endMinutes: endHour * 60 + Number(m2 ?? 0),
      zone: zoneLabel.replace(/\s+/g, ' '),
      offsetMinutes,
      text: whole.trim(),
    });
  }
  return ranges;
}

export type HoursFit = 'ok' | 'partial' | 'past';

export interface LocalHours {
  /** Minutes after local midnight. `end` exceeds 1440 when the range runs past midnight. */
  start: number;
  end: number;
}

const DAY = 24 * 60;
/** A working day is taken to start no earlier than 05:00 local time. */
const DAY_START = 5 * 60;

export function toLocalHours(range: HoursRange, userOffsetMinutes: number): LocalHours {
  const shift = userOffsetMinutes - range.offsetMinutes;
  const duration = (((range.endMinutes - range.startMinutes) % DAY) + DAY) % DAY || DAY;
  let start = (((range.startMinutes + shift) % DAY) + DAY) % DAY;
  if (start < DAY_START) start += DAY;
  return { start, end: start + duration };
}

/** Compares stated hours with the time the user must finish by ("HH:MM", local). */
export function fitHours(
  range: HoursRange,
  userOffsetMinutes: number,
  mustFinishBy: string,
): HoursFit {
  const [hours, minutes] = mustFinishBy.split(':').map(Number) as [number, number];
  let cutoff = hours * 60 + minutes;
  if (cutoff <= DAY_START) cutoff += DAY;
  const local = toLocalHours(range, userOffsetMinutes);
  if (local.end <= cutoff) return 'ok';
  if (local.start >= cutoff) return 'past';
  return 'partial';
}

export function formatMinutes(total: number): string {
  const minutes = ((total % DAY) + DAY) % DAY;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
