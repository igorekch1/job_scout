import { z } from 'zod';
import type { JobLinkRow } from '../db/schema.js';
import type { HttpClient } from '../http/client.js';

export type QuestionKind = 'text' | 'long_text' | 'single_select' | 'multi_select' | 'boolean';

export interface ApplicationQuestion {
  label: string;
  required: boolean;
  kind: QuestionKind;
  /** Allowed answers for select questions. */
  options: string[];
}

export interface QuestionSet {
  questions: ApplicationQuestion[];
  /** Labels found but deliberately left to the user. */
  skipped: string[];
  /** Where the questions came from, or null when the source has none. */
  origin: 'greenhouse' | null;
}

/** Standard fields the user fills from their own records, never drafted. */
const PERSONAL_FIELDS = new Set([
  'first_name',
  'last_name',
  'preferred_name',
  'email',
  'phone',
  'resume',
  'resume_text',
  'cover_letter',
  'cover_letter_text',
]);

const fieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  values: z.array(z.object({ label: z.string() }).loose()).nullish(),
});
const questionSchema = z.object({
  label: z.string(),
  required: z.boolean().nullish(),
  fields: z.array(fieldSchema),
});
const responseSchema = z.object({
  questions: z.array(questionSchema).nullish(),
  location_questions: z.array(questionSchema).nullish(),
  compliance: z.array(z.object({ questions: z.array(questionSchema).nullish() }).loose()).nullish(),
  demographic_questions: z.unknown().nullish(),
});

const KIND: Readonly<Record<string, QuestionKind>> = {
  input_text: 'text',
  textarea: 'long_text',
  multi_value_single_select: 'single_select',
  multi_value_multi_select: 'multi_select',
  input_hidden: 'text',
};

/** Maps a Greenhouse job payload fetched with `?questions=true`. */
export function mapGreenhouseQuestions(payload: unknown): QuestionSet {
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) return { questions: [], skipped: [], origin: 'greenhouse' };
  const data = parsed.data;
  const questions: ApplicationQuestion[] = [];
  const skipped: string[] = [];

  for (const question of [...(data.questions ?? []), ...(data.location_questions ?? [])]) {
    const fields = question.fields.filter((field) => field.type !== 'input_file');
    if (fields.length === 0 || question.fields.some((field) => PERSONAL_FIELDS.has(field.name))) {
      skipped.push(question.label);
      continue;
    }
    const field = fields[0]!;
    const options = (field.values ?? []).map((value) => value.label);
    const kind: QuestionKind =
      KIND[field.type] ??
      (options.length === 2 && options.every((option) => /^(yes|no)$/i.test(option))
        ? 'boolean'
        : 'text');
    questions.push({
      label: question.label.trim(),
      required: question.required === true,
      kind,
      options,
    });
  }

  // equal-opportunity and demographic questions are personal: the user answers them
  const compliance = (data.compliance ?? []).flatMap((group) => group.questions ?? []);
  if (compliance.length > 0 || data.demographic_questions) {
    skipped.push('Equal-opportunity and demographic questions');
  }
  return { questions, skipped, origin: 'greenhouse' };
}

function greenhouseTarget(
  links: readonly Pick<JobLinkRow, 'sourceType' | 'sourceId' | 'externalId' | 'url'>[],
): { board: string; jobId: string } | null {
  const api = links.find((link) => link.sourceType === 'greenhouse');
  if (api)
    return { board: api.sourceId.slice(api.sourceId.indexOf(':') + 1), jobId: api.externalId };
  for (const link of links) {
    const match = /^https?:\/\/(?:job-)?boards\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i.exec(
      link.url,
    );
    if (match) return { board: match[1]!, jobId: match[2]! };
  }
  return null;
}

/**
 * Application questions of a posting, when its ATS publishes them. Greenhouse does; the public
 * Ashby and Lever APIs and RSS feeds do not, so those get an empty set.
 */
export async function fetchQuestions(
  links: readonly Pick<JobLinkRow, 'sourceType' | 'sourceId' | 'externalId' | 'url'>[],
  http: HttpClient,
): Promise<QuestionSet> {
  const target = greenhouseTarget(links);
  if (!target) return { questions: [], skipped: [], origin: null };
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(target.board)}/jobs/${encodeURIComponent(target.jobId)}?questions=true`;
  const response = await http.get(url, { accept: 'application/json' });
  return mapGreenhouseQuestions(JSON.parse(response.body));
}
