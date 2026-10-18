import { z } from 'zod'
import { Port } from '../kernel/port'

// Small ports, one job each. Xero can do all three; ServiceM8 holds quotes but
// not bills; a client on MYOB for invoices and ServiceM8 for quotes binds a
// different adapter to each. No adapter has to stub out methods it can't do.

export interface Contact { id: string; name: string; email?: string }

export interface Invoice {
  id: string
  number: string
  contact: Contact
  total: number
  amountDue: number
  currency: string
  issuedOn: string
  dueOn: string
  /** Link the customer can pay from, if the system has one. */
  onlineUrl?: string
}

export interface Quote {
  id: string
  number: string
  contact: Contact
  total: number
  currency: string
  sentOn: string
  expiresOn?: string
  title?: string
}

/** Invoices sent, not fully paid. */
export abstract class InvoiceSource extends Port {
  abstract outstanding(): Promise<Invoice[]>
}

/** Quotes sent, not yet accepted or declined. */
export abstract class QuoteSource extends Port {
  abstract open(): Promise<Quote[]>
}

export const billLineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().positive(),
  unitAmount: z.number(),
  accountCode: z.string().max(20).optional(),
})

export const billDraftSchema = z.object({
  supplierName: z.string().trim().min(1).max(200),
  supplierAbn: z.string().regex(/^\d{2} ?\d{3} ?\d{3} ?\d{3}$/).optional(),
  reference: z.string().trim().max(100).optional(),
  issuedOn: z.iso.date(),
  dueOn: z.iso.date().optional(),
  currency: z.string().length(3).default('AUD'),
  /** Line amounts include GST, as Australian supplier bills usually do. */
  taxInclusive: z.boolean().default(true),
  lines: z.array(billLineSchema).min(1).max(100),
  total: z.number(),
})

export type BillDraft = z.infer<typeof billDraftSchema>

/** Where supplier bills go. Always as a draft, so the accounting system is a second check. */
export abstract class BillSink extends Port {
  /** `idempotencyKey` makes a retried call create one bill, not two. */
  abstract createDraftBill(bill: BillDraft, opts?: { idempotencyKey?: string }): Promise<{ id: string; url?: string }>
}
