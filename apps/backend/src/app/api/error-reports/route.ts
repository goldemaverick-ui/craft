import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuth } from '@/lib/api/with-auth';
import { withRateLimit } from '@/lib/api/with-rate-limit';
import { errorReportService } from '@/services/error-report.service';

const submitSchema = z.object({
    correlationId: z.string().max(128).optional(),
    description: z.string().min(1, 'Description is required').max(2000),
    errorContext: z.object({
        status: z.number().int().optional(),
        message: z.string().max(500),
        code: z.string().max(128).optional(),
        url: z.string().url().optional(),
        userAgent: z.string().max(500).optional(),
        stackTrace: z.string().max(51200).optional(),
    }),
});

/**
 * POST /api/error-reports
 * Submits a user error report for support team review.
 * Authenticated. Rate limited to 10 reports per 15 minutes per IP.
 */
export const POST = withRateLimit('error-reports:submit', { limit: 10, windowMs: 15 * 60 * 1000 })(
    withAuth(async (req: NextRequest, { user }) => {
        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
        }

        const parsed = submitSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json(
                { error: 'Invalid input', details: parsed.error.flatten().fieldErrors },
                { status: 400 }
            );
        }

        try {
            const report = await errorReportService.submit(user.id, parsed.data);
            return NextResponse.json({ id: report.id, status: report.status }, { status: 201 });
        } catch (err: any) {
            console.error('Error submitting error report:', err);
            return NextResponse.json({ error: 'Failed to submit report' }, { status: 500 });
        }
    })
);
