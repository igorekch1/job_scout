import { describe, expect, it } from 'vitest';
import {
  fitHours,
  formatMinutes,
  parseHoursRanges,
  toLocalHours,
  zoneOffsetMinutes,
} from '../../src/normalize/hours.js';

const WINTER = new Date('2026-01-15T12:00:00Z');
const SUMMER = new Date('2026-07-15T12:00:00Z');

const one = (text: string, at = WINTER) => {
  const [range] = parseHoursRanges(text, at);
  return (
    range && [
      formatMinutes(range.startMinutes),
      formatMinutes(range.endMinutes),
      range.offsetMinutes,
    ]
  );
};

describe('zoneOffsetMinutes', () => {
  it('follows daylight saving time', () => {
    expect(zoneOffsetMinutes('Europe/Amsterdam', WINTER)).toBe(60);
    expect(zoneOffsetMinutes('Europe/Amsterdam', SUMMER)).toBe(120);
    expect(zoneOffsetMinutes('America/New_York', WINTER)).toBe(-300);
    expect(zoneOffsetMinutes('Asia/Kolkata', WINTER)).toBe(330);
    expect(zoneOffsetMinutes('UTC', WINTER)).toBe(0);
  });
});

describe('parseHoursRanges', () => {
  it.each([
    ['Working hours: 9am-5pm PST', ['09:00', '17:00', -480]],
    ['core hours 9:00–17:00 ET', ['09:00', '17:00', -300]],
    ['10 AM to 6 PM EST', ['10:00', '18:00', -300]],
    ['available 9-5 CET', ['09:00', '17:00', 60]],
    ['overlap 1-5pm PT', ['13:00', '17:00', -480]],
    ['shift 11-7pm Eastern Time', ['11:00', '19:00', -300]],
    ['between 14:00 - 22:00 UTC+2', ['14:00', '22:00', 120]],
    ['08:30 to 17:30 (GMT-5)', ['08:30', '17:30', -300]],
    ['9 a.m. until 6 p.m. Pacific Time', ['09:00', '18:00', -480]],
  ])('reads "%s"', (text, expected) => {
    expect(one(text)).toEqual(expected);
  });

  it('uses the offset in force on the reference date', () => {
    expect(one('9am-5pm PT', SUMMER)?.[2]).toBe(-420);
  });

  it('ignores number ranges that are not times', () => {
    expect(parseHoursRanges('3-5 years of experience, EST preferred')).toEqual([]);
    expect(parseHoursRanges('team of 10-12 people in CET')).toEqual([]);
    expect(parseHoursRanges('no hours stated')).toEqual([]);
  });
});

describe('fitHours', () => {
  const amsterdam = zoneOffsetMinutes('Europe/Amsterdam', WINTER);
  const [pacific] = parseHoursRanges('9am-5pm PST', WINTER);
  const [eastern] = parseHoursRanges('9am-1pm EST', WINTER);
  const [easternFull] = parseHoursRanges('9am-5pm EST', WINTER);
  const [cet] = parseHoursRanges('9:00-17:00 CET', WINTER);

  it('converts to local time', () => {
    const local = toLocalHours(pacific!, amsterdam);
    expect([formatMinutes(local.start), formatMinutes(local.end)]).toEqual(['18:00', '02:00']);
  });

  it('classifies ranges against the cutoff', () => {
    expect(fitHours(cet!, amsterdam, '19:00')).toBe('ok');
    expect(fitHours(eastern!, amsterdam, '19:00')).toBe('ok'); // 15:00-19:00 local
    expect(fitHours(easternFull!, amsterdam, '19:00')).toBe('partial'); // 15:00-23:00 local
    expect(fitHours(pacific!, amsterdam, '19:00')).toBe('partial'); // 18:00-02:00 local
    expect(fitHours(pacific!, amsterdam, '18:00')).toBe('past');
  });

  it('treats night ranges as past the cutoff', () => {
    const [night] = parseHoursRanges('2pm-10pm PST', WINTER); // 23:00-07:00 local
    expect(fitHours(night!, amsterdam, '22:00')).toBe('past');
  });
});
