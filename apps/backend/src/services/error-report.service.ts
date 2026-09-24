import { createClient } from '@/lib/supabase/server';
import type {
    ErrorReport,
    ErrorReportStatus,
    ErrorContext,
    SubmitErrorReportRequest,
} from '@craft/types';

// Matches practical email addresses (local part: alphanumeric + ._%+-)
const EMAIL_RE = /\b[a-zA-Z0-9][a-zA-Z0-9._%+\-]*@[a-zA-Z0-9][a-zA-Z0-9.\-]*\.[a-zA-Z]{2,}\b/g;

// Stellar G-keys: 56-char base32 strings starting with G (chars: A-Z, 2-7)
const STELLAR_KEY_RE = /\bG[A-Z2-7]{55}\b/g;

// 13-19 consecutive digit sequences (credit card numbers)
const CREDIT_CARD_RE = /\b\d{13,19}\b/g;

export function sanitizeString(s: string): string {
    return s
        .replace(EMAIL_RE, '[REDACTED_EMAIL]')
        .replace(STELLAR_KEY_RE, (k) => `${k.slice(0, 4)}...${k.slice(-4)}`)
        .replace(CREDIT_CARD_RE, '[REDACTED_CARD]');
}

function sanitizeContext(ctx: ErrorContext): ErrorContext {
    return {
        ...ctx,
        message: sanitizeString(ctx.message),
        ...(ctx.url !== undefined && { url: sanitizeString(ctx.url) }),
        ...(ctx.code !== undefined && { code: sanitizeString(ctx.code) }),
        ...(ctx.userAgent !== undefined && { userAgent: sanitizeString(ctx.userAgent) }),
        ...(ctx.stackTrace !== undefined && { stackTrace: sanitizeString(ctx.stackTrace) }),
    };
}

function sanitizeRequest(req: SubmitErrorReportRequest): SubmitErrorReportRequest {
    return {
        ...req,
        description: sanitizeString(req.description),
        errorContext: sanitizeContext(req.errorContext),
    };
}

export class ErrorReportService {
    /**
     * Submit a new error report on behalf of a user.
     * PII (emails, Stellar keys, credit card numbers) is redacted before storage.
     * Returns the created report.
     */
    async submit(
        userId: string,
        req: SubmitErrorReportRequest
    ): Promise<ErrorReport> {
        const supabase = createClient();
        const sanitized = sanitizeRequest(req);

        const { data, error } = await supabase
            .from('error_reports')
            .insert({
                user_id: userId,
                correlation_id: sanitized.correlationId ?? null,
                description: sanitized.description,
                error_context: sanitized.errorContext as any,
                status: 'open',
            })
            .select()
            .single();

        if (error) {
            throw new Error(`Failed to submit error report: ${error.message}`);
        }

        return this.mapRow(data);
    }

    /**
     * List all reports for a given user, newest first.
     */
    async listForUser(userId: string): Promise<ErrorReport[]> {
        const supabase = createClient();

        const { data, error } = await supabase
            .from('error_reports')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) {
            throw new Error(`Failed to list error reports: ${error.message}`);
        }

        return (data ?? []).map((row) => this.mapRow(row));
    }

    private mapRow(row: any): ErrorReport {
        return {
            id: row.id,
            userId: row.user_id,
            correlationId: row.correlation_id ?? undefined,
            description: row.description,
            errorContext: row.error_context,
            status: row.status as ErrorReportStatus,
            createdAt: new Date(row.created_at),
        };
    }
}

export const errorReportService = new ErrorReportService();
