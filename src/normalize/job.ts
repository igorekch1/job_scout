export type WorkMode = 'remote' | 'hybrid' | 'onsite';
export type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'internship';
export type SalaryPeriod = 'hour' | 'day' | 'week' | 'month' | 'year';

export interface Salary {
  min: number | null;
  max: number | null;
  /** ISO 4217 code, or null when only an unknown symbol was found. */
  currency: string | null;
  period: SalaryPeriod | null;
  /** True when the period was guessed from the size of the amount. */
  periodInferred: boolean;
  /** The text the salary was read from. */
  text: string;
}

export interface JobLocation {
  /** Location as written by the source. */
  text: string | null;
  workMode: WorkMode | null;
  /** ISO 3166-1 alpha-2 codes the posting names. */
  countries: string[];
  /** Region ids from the gazetteer, e.g. "worldwide", "europe". */
  regions: string[];
}

/** What a source returns: fields as the source states them, before parsing. */
export interface RawJob {
  externalId: string;
  url: string;
  title: string;
  company?: string | null;
  descriptionHtml?: string | null;
  descriptionText?: string | null;
  locationText?: string | null;
  workMode?: WorkMode | null;
  /** Work mode to assume when neither the source nor the text states one. */
  workModeFallback?: WorkMode | null;
  /** Structured salary, when the source provides one. */
  salary?: Salary | null;
  /** Free-text salary, when the source has a dedicated field for it. */
  salaryText?: string | null;
  employmentType?: EmploymentType | null;
  postedAt?: Date | null;
  raw: unknown;
}

/** The single shape every source is normalized to. */
export interface Job {
  sourceType: string;
  sourceId: string;
  externalId: string;
  url: string;
  canonicalUrl: string;
  company: string | null;
  title: string;
  description: string;
  location: JobLocation;
  /** True for remote roles, false for hybrid/on-site, null when unknown. */
  remote: boolean | null;
  salary: Salary | null;
  employmentType: EmploymentType | null;
  postedAt: Date | null;
  raw: unknown;
}
