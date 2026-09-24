import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './route';
import { NextRequest } from 'next/server';

// ── Auth mock ────────────────────────────────────────────────────────────────
const mockGetUser = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
    createClient: () => ({
        auth: { getUser: mockGetUser },
    }),
}));

// ── Service mock ─────────────────────────────────────────────────────────────
const mockSubmit = vi.fn();
vi.mock('@/services/error-report.service', () => ({
    errorReportService: { submit: (...args: any[]) => mockSubmit(...args) },
}));

// ── Rate limit bypass ────────────────────────────────────────────────────────
vi.mock('@/lib/api/rate-limit', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/api/rate-limit')>();
    return { ...actual, checkRateLimit: () => ({ allowed: true, remaining: 9, resetAt: 0, retryAfterMs: 0 }) };
});

// ── Helpers ──────────────────────────────────────────────────────────────────
const MOCK_USER = { id: 'user-1', email: 'test@example.com' };

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
    return new NextRequest('http://localhost/api/error-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}

describe('POST /api/error-reports', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetUser.mockResolvedValue({ data: { user: MOCK_USER }, error: null });
        mockSubmit.mockResolvedValue({ id: 'report-1', status: 'open', createdAt: new Date() });
    });

    it('returns 201 with report id on valid input', async () => {
        const req = makeRequest({
            description: 'I clicked deploy and it broke',
            errorContext: { status: 500, message: 'Internal Server Error' },
        });

        const res = await POST(req, { params: {} });
        expect(res.status).toBe(201);

        const body = await res.json();
        expect(body.id).toBe('report-1');
        expect(body.status).toBe('open');
    });

    it('passes correlationId to the service', async () => {
        const req = makeRequest({
            correlationId: 'ERR_001',
            description: 'Something broke',
            errorContext: { message: 'oops' },
        });

        await POST(req, { params: {} });

        expect(mockSubmit).toHaveBeenCalledWith(
            'user-1',
            expect.objectContaining({ correlationId: 'ERR_001' })
        );
    });

    it('returns 400 when description is missing', async () => {
        const req = makeRequest({ errorContext: { message: 'oops' } });
        const res = await POST(req, { params: {} });
        expect(res.status).toBe(400);
    });

    it('returns 400 when errorContext is missing', async () => {
        const req = makeRequest({ description: 'something broke' });
        const res = await POST(req, { params: {} });
        expect(res.status).toBe(400);
    });

    it('returns 400 for invalid JSON', async () => {
        const req = new NextRequest('http://localhost/api/error-reports', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'not-json',
        });
        const res = await POST(req, { params: {} });
        expect(res.status).toBe(400);
    });

    it('returns 401 when unauthenticated', async () => {
        mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no session' } });

        const req = makeRequest({
            description: 'test',
            errorContext: { message: 'oops' },
        });
        const res = await POST(req, { params: {} });
        expect(res.status).toBe(401);
    });

    it('returns 500 when service throws', async () => {
        mockSubmit.mockRejectedValue(new Error('DB error'));

        const req = makeRequest({
            description: 'test',
            errorContext: { message: 'oops' },
        });
        const res = await POST(req, { params: {} });
        expect(res.status).toBe(500);
    });

    it('returns 400 when stack trace exceeds 50KB', async () => {
        const oversizedStackTrace = 'x'.repeat(51201);
        const req = makeRequest({
            description: 'Stack overflow',
            errorContext: { message: 'error', stackTrace: oversizedStackTrace },
        });
        const res = await POST(req, { params: {} });
        expect(res.status).toBe(400);
    });

    it('accepts stack trace up to 50KB', async () => {
        const maxStackTrace = 'x'.repeat(51200);
        const req = makeRequest({
            description: 'Max stack trace',
            errorContext: { message: 'error', stackTrace: maxStackTrace },
        });
        const res = await POST(req, { params: {} });
        expect(res.status).toBe(201);
    });
});
