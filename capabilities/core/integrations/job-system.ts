import { Port } from '../kernel/port'

export interface JobCardDraft {
  customer: { name: string; email?: string; phone?: string }
  address?: string
  /** What the customer asked for, tidied up. */
  description: string
  /** Where it came from: 'website', 'email'. */
  source: string
  urgent?: boolean
}

/** Where a new enquiry becomes a job card or lead. */
export abstract class JobCardSink extends Port {
  abstract createJobCard(card: JobCardDraft): Promise<{ id: string; url?: string }>
}
