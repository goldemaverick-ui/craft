import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';

vi.mock('@/lib/supabase/server', () => ({
    createClient: () => ({
        auth: {
            getUser: vi.fn().mockResolvedValue({
                data: { user: { id: 'user-123', email: 'test@example.com' } },
                error: null,
            }),
        },
        from: vi.fn().mockReturnValue({
            select: vi.fn(() => ({
                eq: vi.fn(() => ({
                    single: vi.fn().mockResolvedValue({ data: { subscription_tier: 'pro' }, error: null })
                }))
            }))
        }),
    }),
}));

const validConfig = {
    branding: {
        appName: 'Test DEX',
        primaryColor: '#4f9eff',
        secondaryColor: '#1a1f36',
        fontFamily: 'Inter',
    },
    features: {
        enableCharts: true,
        enableTransactionHistory: true,
        enableAnalytics: false,
        enableNotifications: false,
    },
    stellar: {
        network: 'testnet',
        horizonUrl: 'https://horizon-testnet.stellar.org',
    },
};

const post = (url: string, body: any) =>
    new NextRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

describe('POST /api/preview/update', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns 200 with update payload for valid request', async () => {
        const changes = {
            branding: {
                appName: 'Updated DEX',
            },
        };

        const res = await POST(
            post('http://localhost/api/preview/update', { current: validConfig, changes }),
            { params: {} }
        );

        expect(res.status).toBe(200);

        const json = await res.json();
        expect(json.customization).toBeDefined();
        expect(json.changedFields).toBeDefined();
        expect(json.timestamp).toBeDefined();
    });

    it('returns updated customization in payload', async () => {
        const changes = {
            branding: {
                appName: 'New Name',
            },
        };

        const res = await POST(
            post('http://localhost/api/preview/update', { current: validConfig, changes }),
            { params: {} }
        );

        const json = await res.json();
        expect(json.customization.branding.appName).toBe('New Name');
        expect(json.customization.branding.primaryColor).toBe(validConfig.branding.primaryColor);
    });

    it('returns changedFields array', async () => {
        const changes = {
            branding: {
                appName: 'Updated',
                primaryColor: '#ff0000',
            },
        };

        const res = await POST(
            post('http://localhost/api/preview/update', { current: validConfig, changes }),
            { params: {} }
        );

        const json = await res.json();
        expect(json.changedFields).toContain('branding.appName');
        expect(json.changedFields).toContain('branding.primaryColor');
    });

    it('does not include mockData for branding changes', async () => {
        const changes = {
            branding: {
                appName: 'Updated',
            },
        };

        const res = await POST(
            post('http://localhost/api/preview/update', { current: validConfig, changes }),
            { params: {} }
        );

        const json = await res.json();
        expect(json.mockData).toBeUndefined();
    });

    it('includes mockData when network changes', async () => {
        const changes = {
            stellar: {
                network: 'mainnet',
                horizonUrl: 'https://horizon.stellar.org',
            },
        };

        const res = await POST(
            post('http://localhost/api/preview/update', { current: validConfig, changes }),
            { params: {} }
        );

        const json = await res.json();
        expect(json.mockData).toBeDefined();
        expect(json.changedFields).toContain('stellar.network');
    });

    it('returns 400 for invalid JSON', async () => {
        const req = new NextRequest('http://localhost/api/preview/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'invalid json',
        });

        const res = await POST(req, { params: {} });

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('Invalid JSON');
    });

    it('returns 400 when current is missing', async () => {
        const res = await POST(
            post('http://localhost/api/preview/update', { changes: {} }),
            { params: {} }
        );

        expect(res.status).toBe(400);
        expect((await res.json()).error).toContain('Missing required fields');
    });

    it('returns 400 when changes is missing', async () => {
        const res = await POST(
            post('http://localhost/api/preview/update', { current: validConfig }),
            { params: {} }
        );

        expect(res.status).toBe(400);
        expect((await res.json()).error).toContain('Missing required fields');
    });

    it('returns 422 for invalid current config', async () => {
        const invalidCurrent = {
            ...validConfig,
            branding: {
                ...validConfig.branding,
                appName: '',
            },
        };

        const res = await POST(
            post('http://localhost/api/preview/update', { current: invalidCurrent, changes: {} }),
            { params: {} }
        );

        expect(res.status).toBe(422);
        const json = await res.json();
        expect(json.error).toContain('Invalid current customization config');
    });

    it('handles empty changes object', async () => {
        const res = await POST(
            post('http://localhost/api/preview/update', { current: validConfig, changes: {} }),
            { params: {} }
        );

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.changedFields).toEqual([]);
    });

    it('returns valid ISO timestamp', async () => {
        const changes = { branding: { appName: 'Test' } };

        const res = await POST(
            post('http://localhost/api/preview/update', { current: validConfig, changes }),
            { params: {} }
        );

        const json = await res.json();
        expect(new Date(json.timestamp).toString()).not.toBe('Invalid Date');
    });

    it('accepts preview update with sequence parameter', async () => {
        const changes = { branding: { appName: 'Current' } };

        const res = await POST(
            post('http://localhost/api/preview/update', {
                current: validConfig,
                changes,
                sequence: 1
            }),
            { params: {} }
        );

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.customization.branding.appName).toBe('Current');
    });
});
