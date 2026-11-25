import { describe, expect, it } from 'vitest';
import { buildAliases, regionContains, resolveRegion } from '../../src/normalize/gazetteer.js';
import { findPlaces, parseLocation, scanRestrictions } from '../../src/normalize/location.js';

describe('parseLocation', () => {
  it.each([
    ['Remote', 'remote', [], []],
    ['Remote - Europe', 'remote', [], ['europe']],
    ['Remote (US)', 'remote', ['US'], []],
    ['Remote, EMEA', 'remote', [], ['emea']],
    ['Remote - European Union', 'remote', [], ['eu']],
    ['Worldwide', 'remote', [], ['worldwide']],
    ['Anywhere', 'remote', [], ['worldwide']],
    ['Berlin, Germany (Hybrid)', 'hybrid', ['DE'], []],
    ['London, UK - On-site', 'onsite', ['GB'], []],
    ['New York, United States', null, ['US'], []],
    ['Bangalore, India', null, ['IN'], []],
    ['Remote: Canada, United States', 'remote', ['CA', 'US'], []],
    ['Remote or Hybrid, Poland', 'remote', ['PL'], []],
    ['US/Canada (Remote)', 'remote', [], ['north-america']],
    ['LATAM remote', 'remote', [], ['latam']],
  ])('reads "%s"', (text, workMode, countries, regions) => {
    const location = parseLocation(text);
    expect(location.workMode).toBe(workMode);
    expect(location.countries).toEqual(countries);
    expect(location.regions).toEqual(regions);
  });

  it('returns an empty location for missing text', () => {
    expect(parseLocation(null)).toEqual({ text: null, workMode: null, countries: [], regions: [] });
    expect(parseLocation('   ').text).toBeNull();
  });

  it('does not read ordinary lowercase words as country codes', () => {
    expect(findPlaces('join us and help the eu team').countries).toEqual([]);
    expect(findPlaces('join us and help the eu team').regions).toEqual([]);
    expect(findPlaces('US or UK').countries).toEqual(['GB', 'US']);
  });

  it('lets longer names win', () => {
    expect(findPlaces('New Mexico').countries).toEqual(['US']);
    expect(findPlaces('South Africa')).toEqual({ countries: ['ZA'], regions: [] });
  });

  it('uses extra aliases from config', () => {
    const aliases = buildAliases({ nederland: 'NL', iberia: 'europe' });
    expect(parseLocation('Remote, Nederland', aliases).countries).toEqual(['NL']);
    expect(parseLocation('Iberia', aliases).regions).toEqual(['europe']);
  });
});

describe('scanRestrictions', () => {
  it.each([
    ['This role is US-only.', ['US'], []],
    ['Open to EU only candidates', [], ['eu']],
    ['You must be based in the United States.', ['US'], []],
    ['Candidates must reside in Canada or Mexico', ['CA', 'MX'], []],
    ['Applicants must be authorized to work in the UK.', ['GB'], []],
    ['Senior Engineer (Remote, EMEA)', [], ['emea']],
    ['Remote (US & Canada)', [], ['north-america']],
    ['This is a remote position within Europe.', [], ['europe']],
    ['We hire remotely from Poland and Portugal', ['PL', 'PT'], []],
    ['Work from anywhere in the world.', [], ['worldwide']],
  ])('reads "%s"', (text, countries, regions) => {
    expect(scanRestrictions(text)).toMatchObject({ countries, regions });
  });

  it('ignores office addresses and team descriptions', () => {
    const text =
      'Our headquarters are in Berlin and we have teams in Canada, India and Brazil. Remote only.';
    expect(scanRestrictions(text)).toEqual({ countries: [], regions: [], remote: false });
    expect(scanRestrictions('Remote (US)').remote).toBe(true);
    expect(scanRestrictions('Must be based in the US').remote).toBe(false);
  });
});

describe('gazetteer', () => {
  it('knows region membership', () => {
    expect(regionContains('worldwide', 'NL')).toBe(true);
    expect(regionContains('europe', 'UA')).toBe(true);
    expect(regionContains('eu', 'UA')).toBe(false);
    expect(regionContains('emea', 'ZA')).toBe(true);
    expect(regionContains('north-america', 'NL')).toBe(false);
    expect(regionContains('cet', 'NL')).toBe(false);
    expect(regionContains('nowhere', 'NL')).toBe(false);
  });

  it('resolves region names and aliases', () => {
    expect(resolveRegion('Europe')).toBe('europe');
    expect(resolveRegion('emea')).toBe('emea');
    expect(resolveRegion('global')).toBe('worldwide');
    expect(resolveRegion('atlantis')).toBeUndefined();
  });
});
