import { XMLParser } from 'fast-xml-parser';
import type { RssFeedConfig } from '../config/schema.js';
import type { RawJob } from '../normalize/job.js';
import { collapseWhitespace } from '../util/text.js';
import { parseDate, type FetchContext, type Source } from './types.js';

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  processEntities: true,
  isArray: (name) => name === 'item' || name === 'entry' || name === 'link',
});

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null;

/** Text of an element that may be a string, a `{ '#text': ... }` node or missing. */
function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return text(value[0]);
  if (isNode(value)) return text(value['#text']);
  return null;
}

const first = (node: Node, ...keys: string[]): string | null => {
  for (const key of keys) {
    const value = text(node[key]);
    if (value) return value;
  }
  return null;
};

/** RSS has `<link>url</link>`; Atom has `<link href="url" rel="alternate"/>`, possibly several. */
function linkOf(node: Node): string | null {
  const links = node.link;
  if (!Array.isArray(links)) return text(links);
  const candidates = links as unknown[];
  const atom = candidates.filter(isNode).filter((entry) => typeof entry['@_href'] === 'string');
  if (atom.length > 0) {
    const alternate = atom.find((entry) => !entry['@_rel'] || entry['@_rel'] === 'alternate');
    return ((alternate ?? atom[0]!)['@_href'] as string).trim();
  }
  return text(candidates[0]);
}

function itemsOf(document: unknown): Node[] {
  if (!isNode(document)) return [];
  const rss = document.rss;
  if (isNode(rss) && isNode(rss.channel) && Array.isArray(rss.channel.item)) {
    return (rss.channel.item as unknown[]).filter(isNode);
  }
  const rdf = document['rdf:RDF'];
  if (isNode(rdf) && Array.isArray(rdf.item)) return (rdf.item as unknown[]).filter(isNode);
  const feed = document.feed;
  if (isNode(feed) && Array.isArray(feed.entry)) return (feed.entry as unknown[]).filter(isNode);
  return [];
}

const isFeed = (document: unknown): boolean =>
  isNode(document) &&
  (isNode(document.rss) || isNode(document.feed) || isNode(document['rdf:RDF']));

/** Maps one RSS item or Atom entry. Returns null when it has no title or link. */
export function mapFeedItem(item: Node, feed: RssFeedConfig): RawJob | null {
  const rawTitle = first(item, 'title');
  const url = linkOf(item) ?? first(item, 'guid', 'id');
  if (!rawTitle || !url || !/^https?:\/\//i.test(url)) return null;

  let title = collapseWhitespace(rawTitle);
  let company = first(item, 'company', 'job:company', 'job_listing:company', 'dc:creator');
  const author = item.author;
  company ??= isNode(author) ? first(author, 'name') : text(author);

  if (feed.title_pattern) {
    const groups = new RegExp(feed.title_pattern, 'iu').exec(title)?.groups;
    if (groups?.company?.trim()) company = groups.company.trim();
    if (groups?.title?.trim()) title = groups.title.trim();
  }

  return {
    externalId: first(item, 'guid', 'id') ?? url,
    url,
    title,
    company: company ?? feed.defaults.company ?? null,
    descriptionHtml: first(item, 'content:encoded', 'content', 'description', 'summary'),
    locationText: first(item, 'location', 'job:location', 'job_listing:location', 'region'),
    workMode: feed.defaults.remote === true ? 'remote' : null,
    salaryText: first(item, 'salary', 'job:salary', 'job_listing:salary'),
    employmentType: feed.defaults.employment_type ?? null,
    postedAt: parseDate(first(item, 'pubDate', 'published', 'updated', 'dc:date')),
    raw: item,
  };
}

/** Parses a feed document into raw jobs. Throws when the document is not RSS or Atom. */
export function parseFeed(xml: string, feed: RssFeedConfig): RawJob[] {
  let document: unknown;
  try {
    document = parser.parse(xml);
  } catch {
    throw new Error(`Feed "${feed.id}" is not valid XML`);
  }
  if (!isFeed(document)) throw new Error(`Feed "${feed.id}" is not an RSS or Atom document`);
  return itemsOf(document).flatMap((item) => mapFeedItem(item, feed) ?? []);
}

export function createRssSource(feed: RssFeedConfig, intervalMinutes: number): Source {
  return {
    id: `rss:${feed.id}`,
    type: 'rss',
    intervalMinutes,
    async fetch({ http }: FetchContext): Promise<RawJob[]> {
      const result = await http.getText(
        feed.url,
        'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8',
      );
      if (result.notModified || result.data === null) return [];
      return parseFeed(result.data, feed);
    },
  };
}
