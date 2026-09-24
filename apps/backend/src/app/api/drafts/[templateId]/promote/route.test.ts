import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Supabase mock ─────────────────────────────────────────────────────────────
const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
    createClient: () => ({
        auth: { getUser: mockGetUser },
        from: mockFrom,
    }),
}));

// ── Service mocks ─────────────────────────────────────────────────────────────
const mockPromoteDraft = vi.fn();

vi.mock('@/services/customization-draft.service', () => ({
    customizationDraftService: {
        promoteDraft: mockPromoteDraft,
    },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────
const fakeUser = { id: 'user-1', email: 'a@b.com' };
const templateId = 'tmpl-1';
const deploymentId = 'dep-1';
const params = { templateId };

const successResult = {
    success: true,
    deploymentId,
    rolledBack: false,
    deploymentUrl: 'https://my-dex.vercel.app',
};

const makeRequest = (body?: unknown) =>
    new NextRequest(`http://localhost/api/drafts/${templateId}/promote`, {
        method: 'POST',
        ...(body !== undefined
            ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
            : {}),
    });

// ── POST /api/drafts/[templateId]/promote ─────────────────────────────────────
describe('POST /api/drafts/[templateId]/promote', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetUser.mockResolvedValue({ data: { user: fakeUser }, error: null });
    });

    it('returns 401 when unauthenticated', async () => {
        mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
        const { POST } = await import('./route');
        const res = await POST(makeRequest({ deploymentId }), { params });
        expect(res.status).toBe(401);
    });

    it('returns 400 for invalid JSON', async () => {
        const { POST } = await import('./route');
        const req = new NextRequest(`http://localhost/api/drafts/${templateId}/promote`, {
            method: 'POST',
            body: 'not-json',
            headers: { 'Content-Type': 'application/json' },
        });
        const res = await POST(req, { params });
        expect(res.status).toBe(400);
    });

    it('returns 400 when deploymentId is missing', async () => {
        const { POST } = await import('./route');
        const res = await POST(makeRequest({}), { params });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/deploymentId/);
    });

    it('returns 404 when draft is not found', async () => {
        mockPromoteDraft.mockRejectedValue(new Error('Draft not found'));
        const { POST } = await import('./route');
        const res = await POST(makeRequest({ deploymentId }), { params });
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toBe('Draft not found');
    });

    it('returns 400 with details when draft config is invalid', async () => {
        const validationErrors = [{ field: 'branding.appName', message: 'App name is required', code: 'TOO_SMALL' }];
        const err = Object.assign(new Error('Invalid draft configuration'), { validationErrors });
        mockPromoteDraft.mockRejectedValue(err);
        const { POST } = await import('./route');
        const res = await POST(makeRequest({ deploymentId }), { params });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.details).toEqual(validationErrors);
    });

    it('returns 404 when deployment is not found or access denied', async () => {
        mockPromoteDraft.mockResolvedValue({
            success: false,
            deploymentId,
            rolledBack: false,
            errorMessage: 'Deployment not found or access denied',
        });
        const { POST } = await import('./route');
        const res = await POST(makeRequest({ deploymentId }), { params });
        expect(res.status).toBe(404);
    });

    it('returns 200 with result on successful promotion', async () => {
        mockPromoteDraft.mockResolvedValue(successResult);
        const { POST } = await import('./route');
        const res = await POST(makeRequest({ deploymentId }), { params });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.deploymentId).toBe(deploymentId);
        expect(body.deploymentUrl).toBe('https://my-dex.vercel.app');
    });

    it('calls promoteDraft with correct userId, templateId, and deploymentId', async () => {
        mockPromoteDraft.mockResolvedValue(successResult);
        const { POST } = await import('./route');
        await POST(makeRequest({ deploymentId }), { params });
        expect(mockPromoteDraft).toHaveBeenCalledWith(fakeUser.id, templateId, deploymentId);
    });

    it('returns 500 on unexpected service error', async () => {
        mockPromoteDraft.mockRejectedValue(new Error('Unexpected DB failure'));
        const { POST } = await import('./route');
        const res = await POST(makeRequest({ deploymentId }), { params });
        expect(res.status).toBe(500);
    });

    it('can retry promotion after mid-promotion failure', async () => {
        const failureResult = {
            success: false,
            deploymentId,
            rolledBack: true,
            errorMessage: 'GitHub push failed, deployment rolled back',
        };
        const retryResult = {
            success: true,
            deploymentId,
            rolledBack: false,
            deploymentUrl: 'https://my-dex.vercel.app',
        };

        mockPromoteDraft.mockResolvedValueOnce(failureResult);
        const { POST } = await import('./route');
        let res = await POST(makeRequest({ deploymentId }), { params });
        expect(res.status).toBe(500);

        mockPromoteDraft.mockResolvedValueOnce(retryResult);
        res = await POST(makeRequest({ deploymentId }), { params });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(mockPromoteDraft).toHaveBeenCalledTimes(2);
        expect(mockPromoteDraft).toHaveBeenNthCalledWith(1, fakeUser.id, templateId, deploymentId);
        expect(mockPromoteDraft).toHaveBeenNthCalledWith(2, fakeUser.id, templateId, deploymentId);
    });
});
