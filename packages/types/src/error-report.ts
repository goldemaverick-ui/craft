export type ErrorReportStatus = 'open' | 'investigating' | 'resolved';

export interface ErrorReport {
    id: string;
    userId: string;
    /** Correlation ID from the original error (e.g. errorCode shown in the UI). */
    correlationId?: string;
    /** User-supplied description of what they were doing when the error occurred. */
    description: string;
    /** Serialised error context captured at the time of the failure. */
    errorContext: ErrorContext;
    status: ErrorReportStatus;
    createdAt: Date;
}

export interface ErrorContext {
    /** HTTP status code, if applicable. */
    status?: number;
    /** Error message from the system. */
    message: string;
    /** Machine-readable error code. */
    code?: string;
    /** Current page URL at the time of the error. */
    url?: string;
    /** Browser / user-agent string. */
    userAgent?: string;
    /** Stack trace (capped at 50KB). */
    stackTrace?: string;
}

export interface SubmitErrorReportRequest {
    correlationId?: string;
    description: string;
    errorContext: ErrorContext;
}

export interface SubmitErrorReportResponse {
    id: string;
    status: ErrorReportStatus;
}
