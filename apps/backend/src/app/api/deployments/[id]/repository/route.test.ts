import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockCreateRepository = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
    createClient: () => ({
        auth: { getUser: mockGetUser },
        from: mockFrom,
    }),
}));

vi.mock('@/services/github.service', () => ({
    githubService: {
        createRepository: mockCreateRepository,
    },
}));

type QueryResult = {
    data: Record<string, unknown> | null;
    error: { message: string } | null;
};

const fakeUser = { id: 'user-1', email: 'user@example.com' };
const params = { id: 'dep-1' };

function makeRequest(body?: unknown) {
    return new NextRequest('http://localhost/api/deployments/dep-1/repository', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

function makeSupabaseQuery(selectResults: QueryResult[]) {
    const update = vi.fn(() => ({
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
    }));

    const select = vi.fn(() => ({
        eq: vi.fn(() => ({
            single: vi.fn().mockResolvedValue(selectResults.shift() ?? { data: null, error: null }),
        })),
    }));

    return { select, update };
}

describe('POST /api/deployments/[id]/repository', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetUser.mockResolvedValue({ data: { user: fakeUser }, error: null });
    });

    it('returns 401 when unauthenticated', async () => {
        mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
        const { POST } = await import('./route');

        const res = await POST(makeRequest({}), { params });

        expect(res.status).toBe(401);
    });

    it('returns 403 when the deployment does not belong to the user', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([{ data: { user_id: 'other-user' }, error: null }]),
        );
        const { POST } = await import('./route');

        const res = await POST(makeRequest({}), { params });

        expect(res.status).toBe(403);
        expect(mockCreateRepository).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid JSON', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]),
        );
        const { POST } = await import('./route');
        const req = new NextRequest('http://localhost/api/deployments/dep-1/repository', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'not-json',
        });

        const res = await POST(req, { params });

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('Invalid JSON');
    });

    it('returns 400 for an invalid request body shape', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]),
        );
        const { POST } = await import('./route');

        const res = await POST(makeRequest({ topics: [123] }), { params });

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('Invalid request body');
    });

    it('returns 404 when the deployment record cannot be loaded', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([
                { data: { user_id: fakeUser.id }, error: null },
                { data: null, error: { message: 'not found' } },
            ]),
        );
        const { POST } = await import('./route');

        const res = await POST(makeRequest({}), { params });

        expect(res.status).toBe(404);
    });

    it('creates a repository, persists the URL, and returns deployment identifiers', async () => {
        const deploymentsTable = makeSupabaseQuery([
            { data: { user_id: fakeUser.id }, error: null },
            { data: { name: 'My DEX' }, error: null },
        ]);
        mockFrom.mockImplementation((table: string) => {
            expect(table).toBe('deployments');
            return deploymentsTable;
        });
        mockCreateRepository.mockResolvedValue({
            repository: {
                id: 123,
                url: 'https://github.com/acme/my-dex',
                cloneUrl: 'https://github.com/acme/my-dex.git',
                sshUrl: 'git@github.com:acme/my-dex.git',
                fullName: 'acme/my-dex',
                defaultBranch: 'main',
                private: true,
            },
            resolvedName: 'my-dex',
        });
        const { POST } = await import('./route');

        const res = await POST(
            makeRequest({
                description: 'Generated deployment repo',
                homepage: 'https://craft.example.com',
                topics: ['dex', 'stellar'],
            }),
            { params },
        );

        expect(res.status).toBe(201);
        expect(mockCreateRepository).toHaveBeenCalledWith({
            name: 'My DEX',
            description: 'Generated deployment repo',
            homepage: 'https://craft.example.com',
            topics: ['dex', 'stellar'],
            private: true,
            userId: fakeUser.id,
        });

        const body = await res.json();
        expect(body).toMatchObject({
            repositoryId: 123,
            repositoryUrl: 'https://github.com/acme/my-dex',
            cloneUrl: 'https://github.com/acme/my-dex.git',
            sshUrl: 'git@github.com:acme/my-dex.git',
            fullName: 'acme/my-dex',
            defaultBranch: 'main',
            resolvedName: 'my-dex',
        });
        expect(deploymentsTable.update).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ status: 'creating_repo' }),
        );
        expect(deploymentsTable.update).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                repository_url: 'https://github.com/acme/my-dex',
                status: 'pushing_code',
            }),
        );
    });

    it('maps collision errors to 409 and marks the deployment failed', async () => {
        const deploymentsTable = makeSupabaseQuery([
            { data: { user_id: fakeUser.id }, error: null },
            { data: { name: 'My DEX' }, error: null },
        ]);
        mockFrom.mockReturnValue(deploymentsTable);
        mockCreateRepository.mockRejectedValue({ code: 'COLLISION', message: 'taken' });
        const { POST } = await import('./route');

        const res = await POST(makeRequest({}), { params });

        expect(res.status).toBe(409);
        expect(deploymentsTable.update).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ status: 'failed', error_message: 'taken' }),
        );
    });

    it('maps rate limiting to 429 and forwards Retry-After', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([
                { data: { user_id: fakeUser.id }, error: null },
                { data: { name: 'My DEX' }, error: null },
            ]),
        );
        mockCreateRepository.mockRejectedValue({
            code: 'RATE_LIMITED',
            message: 'rate limited',
            retryAfterMs: 12_000,
        });
        const { POST } = await import('./route');

        const res = await POST(makeRequest({}), { params });

        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toBe('12');
    });
});

// ---------------------------------------------------------------------------
// PATCH /api/deployments/[id]/repository
// Feature: github-repository-update-flow
// ---------------------------------------------------------------------------

const mockUpdateRepository = vi.fn();
vi.mock('@/services/github-repository-update.service', () => ({
    githubRepositoryUpdateService: {
        updateRepository: mockUpdateRepository,
    },
}));

function makePatchRequest(body?: unknown) {
    return new NextRequest('http://localhost/api/deployments/dep-1/repository', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

const fakeCommitRef = {
    commitSha: 'abc123',
    treeSha: 'tree456',
    commitUrl: 'https://github.com/acme/my-dex/commit/abc123',
    branch: 'main',
    fileCount: 3,
    owner: 'acme',
    repo: 'my-dex',
    previousCommitSha: 'prev789',
    createdBranch: false,
};

describe('PATCH /api/deployments/[id]/repository', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetUser.mockResolvedValue({ data: { user: fakeUser }, error: null });
    });

    it('returns 401 when unauthenticated', async () => {
        mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
        const { PATCH } = await import('./route');

        const res = await PATCH(makePatchRequest({}), { params });

        expect(res.status).toBe(401);
    });

    it('returns 403 when deployment does not belong to the user', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([{ data: { user_id: 'other-user' }, error: null }]),
        );
        const { PATCH } = await import('./route');

        const res = await PATCH(makePatchRequest({ customizationConfig: {} }), { params });

        expect(res.status).toBe(403);
        expect(mockUpdateRepository).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid JSON', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]),
        );
        const { PATCH } = await import('./route');
        const req = new NextRequest('http://localhost/api/deployments/dep-1/repository', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: 'not-json',
        });

        const res = await PATCH(req, { params });

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('Invalid JSON');
    });

    it('returns 400 when customizationConfig is missing', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]),
        );
        const { PATCH } = await import('./route');

        const res = await PATCH(makePatchRequest({ branch: 'main' }), { params });

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('Invalid request body');
    });

    it('returns 400 when customizationConfig is not an object (string)', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]),
        );
        const { PATCH } = await import('./route');

        const res = await PATCH(makePatchRequest({ customizationConfig: 'not-an-object' }), { params });

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('Invalid request body');
    });

    it('returns 400 when commitMessage is present but not a string', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]),
        );
        const { PATCH } = await import('./route');

        const res = await PATCH(
            makePatchRequest({ customizationConfig: {}, commitMessage: 42 }),
            { params },
        );

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('Invalid request body');
    });

    it('returns 400 when branch is present but not a string', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]),
        );
        const { PATCH } = await import('./route');

        const res = await PATCH(
            makePatchRequest({ customizationConfig: {}, branch: true }),
            { params },
        );

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('Invalid request body');
    });

    it('returns 200 with correct commit metadata on success', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]),
        );
        mockUpdateRepository.mockResolvedValue({
            commitRef: fakeCommitRef,
            deploymentId: 'dep-1',
        });
        const { PATCH } = await import('./route');

        const res = await PATCH(
            makePatchRequest({ customizationConfig: { theme: 'dark' } }),
            { params },
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({
            commitSha: 'abc123',
            treeSha: 'tree456',
            commitUrl: 'https://github.com/acme/my-dex/commit/abc123',
            branch: 'main',
            fileCount: 3,
            owner: 'acme',
            repo: 'my-dex',
            deploymentId: 'dep-1',
        });
    });

    it('returns 429 with Retry-After header on RATE_LIMITED error', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]),
        );
        mockUpdateRepository.mockRejectedValue({
            code: 'RATE_LIMITED',
            message: 'GitHub rate limit exceeded',
            retryAfterMs: 30_000,
        });
        const { PATCH } = await import('./route');

        const res = await PATCH(
            makePatchRequest({ customizationConfig: {} }),
            { params },
        );

        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toBe('30');
    });

    it('returns 502 on NETWORK_ERROR', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]),
        );
        mockUpdateRepository.mockRejectedValue({
            code: 'NETWORK_ERROR',
            message: 'Network error communicating with GitHub',
        });
        const { PATCH } = await import('./route');

        const res = await PATCH(
            makePatchRequest({ customizationConfig: {} }),
            { params },
        );

        expect(res.status).toBe(502);
    });

    it('returns 500 on REPO_NOT_FOUND error', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]),
        );
        mockUpdateRepository.mockRejectedValue({
            code: 'REPO_NOT_FOUND',
            message: 'Repository not found for this deployment',
        });
        const { PATCH } = await import('./route');

        const res = await PATCH(
            makePatchRequest({ customizationConfig: {} }),
            { params },
        );

        expect(res.status).toBe(500);
    });

    it('returns 500 on INVALID_STATE error', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([{ data: { user_id: fakeUser.id }, error: null }]),
        );
        mockUpdateRepository.mockRejectedValue({
            code: 'INVALID_STATE',
            message: "Cannot update deployment in 'pending' state",
        });
        const { PATCH } = await import('./route');

        const res = await PATCH(
            makePatchRequest({ customizationConfig: {} }),
            { params },
        );

        expect(res.status).toBe(500);
    });
});

describe('GET /api/deployments/[id]/repository', () => {
    const mockGetRepositoryMetadata = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetUser.mockResolvedValue({ data: { user: fakeUser }, error: null });
        vi.doMock('@/services/github.service', () => ({
            githubService: {
                getRepositoryMetadata: mockGetRepositoryMetadata,
            },
        }));
    });

    function makeGetRequest() {
        return new NextRequest('http://localhost/api/deployments/dep-1/repository', {
            method: 'GET',
        });
    }

    it('returns 200 with repository metadata for owner', async () => {
        const metadata = {
            defaultBranch: 'main',
            visibility: 'private',
            lastCommitSha: 'abc123',
            lastCommitMessage: 'feat: update',
            lastCommitDate: '2025-01-01T00:00:00Z',
        };
        mockFrom.mockReturnValue(
            makeSupabaseQuery([
                { data: { repository_url: 'https://github.com/user/repo.git', user_id: fakeUser.id }, error: null },
            ]),
        );
        mockGetRepositoryMetadata.mockResolvedValue(metadata);
        const { GET } = await import('./route');

        const res = await GET(makeGetRequest(), { params });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.defaultBranch).toBe('main');
        expect(body.visibility).toBe('private');
    });

    it('returns 404 when deployment not owned by caller', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([
                { data: { repository_url: 'https://github.com/user/repo.git', user_id: 'other-user' }, error: null },
            ]),
        );
        const { GET } = await import('./route');

        const res = await GET(makeGetRequest(), { params });

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toContain('not found');
    });

    it('returns 404 when deployment not found', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([
                { data: null, error: { message: 'not found' } },
            ]),
        );
        const { GET } = await import('./route');

        const res = await GET(makeGetRequest(), { params });

        expect(res.status).toBe(404);
    });

    it('returns 404 when repository not linked', async () => {
        mockFrom.mockReturnValue(
            makeSupabaseQuery([
                { data: { repository_url: null, user_id: fakeUser.id }, error: null },
            ]),
        );
        const { GET } = await import('./route');

        const res = await GET(makeGetRequest(), { params });

        expect(res.status).toBe(404);
    });

    it('returns 401 when unauthenticated', async () => {
        mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
        const { GET } = await import('./route');

        const res = await GET(makeGetRequest(), { params });

        expect(res.status).toBe(401);
    });
});
