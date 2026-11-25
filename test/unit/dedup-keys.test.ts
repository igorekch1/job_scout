import { describe, expect, it } from 'vitest';
import { atsFromUrl, canonicalUrl } from '../../src/dedup/canonical-url.js';
import { fuzzyKey, normalizeCompany, normalizeTitle } from '../../src/dedup/fuzzy-key.js';

describe('canonicalUrl', () => {
  it.each([
    [
      'https://jobs.example.com/jobs/1/?utm_source=x&ref=y#apply',
      'https://jobs.example.com/jobs/1',
    ],
    ['http://WWW.Example.com/Jobs/1', 'https://example.com/Jobs/1'],
    [
      'https://jobs.example.com/search?b=2&a=1&gh_src=abc',
      'https://jobs.example.com/search?a=1&b=2',
    ],
    ['https://boards.greenhouse.io/acme/jobs/42?gh_src=feed', 'https://greenhouse.io/acme/jobs/42'],
    ['https://job-boards.greenhouse.io/acme/jobs/42', 'https://greenhouse.io/acme/jobs/42'],
    ['https://jobs.ashbyhq.com/Acme/abc-123/application', 'https://jobs.ashbyhq.com/acme/abc-123'],
    [
      'https://jobs.lever.co/acme/abc-123/apply?lever-source=x',
      'https://jobs.lever.co/acme/abc-123',
    ],
    ['https://example.com/', 'https://example.com/'],
  ])('%s', (input, expected) => {
    expect(canonicalUrl(input)).toBe(expected);
  });

  it('leaves unparseable input alone', () => {
    expect(canonicalUrl(' not a url ')).toBe('not a url');
  });

  it('recognises ATS hosts', () => {
    expect(atsFromUrl('https://job-boards.greenhouse.io/acme/jobs/1')).toBe('greenhouse');
    expect(atsFromUrl('https://jobs.ashbyhq.com/acme/1')).toBe('ashby');
    expect(atsFromUrl('https://jobs.lever.co/acme/1')).toBe('lever');
    expect(atsFromUrl('https://jobs.example.com/1')).toBeNull();
    expect(atsFromUrl('nope')).toBeNull();
  });
});

describe('fuzzyKey', () => {
  it('normalizes company names', () => {
    expect(normalizeCompany('Acme Robotics, Inc.')).toBe('acmerobotics');
    expect(normalizeCompany('ACME-Robotics GmbH')).toBe('acmerobotics');
    expect(normalizeCompany('acmerobotics')).toBe('acmerobotics');
    expect(normalizeCompany('Café Société Ltd')).toBe('cafesociete');
  });

  it('normalizes titles', () => {
    expect(normalizeTitle('Sr. Front-End Developer (Remote, EMEA)')).toBe(
      'senior frontend engineer',
    );
    expect(normalizeTitle('Senior Frontend Engineer - Remote')).toBe('senior frontend engineer');
    expect(normalizeTitle('Senior Full Stack Software Engineer [m/f/d]')).toBe(
      'senior fullstack engineer',
    );
    expect(normalizeTitle('C++ Engineer')).toBe('c++ engineer');
    expect(normalizeTitle('Design & Research Lead')).toBe('design and research lead');
  });

  it('gives the same key to the same role on different boards', () => {
    const a = fuzzyKey('Acme Robotics', 'Senior Frontend Engineer', 'https://greenhouse.io/a/1');
    const b = fuzzyKey(
      'Acme Robotics Inc',
      'Sr. Front-end Developer (Remote)',
      'https://x.example/2',
    );
    expect(a).toBe('acmerobotics|senior frontend engineer');
    expect(b).toBe(a);
    expect(fuzzyKey('Acme Robotics', 'Senior Backend Engineer', 'https://x.example/3')).not.toBe(a);
  });

  it('falls back to the URL when there is no company', () => {
    expect(fuzzyKey(null, 'Engineer', 'https://x.example/1')).toBe('url:https://x.example/1');
    expect(fuzzyKey('', 'Engineer', 'https://x.example/1')).toBe('url:https://x.example/1');
  });
});
