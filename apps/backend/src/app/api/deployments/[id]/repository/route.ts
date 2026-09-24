/**
 * POST /api/deployments/[id]/repository
 *
 * Creates a private GitHub repository for the given deployment and stores the
 * resulting URL in `deployments.repository_url`. Advances the deployment status
 * through `creating_repo → pushing_code` on success, or marks it `failed` and
 * writes an `error_message` on any error.
 *
 * Authentication & ownership:
 *   Requires a valid session (401) and ownership of the deployment (403).
 *
 * Request body (all optional):
 *   {
 *     "private":     boolean    — default true
 *     "description": string     — forwarded to GitHub as the repo description
 *     "homepage":    string     — optional repository homepage URL
 *     "topics":      string[]   — optional GitHub repository topics
 *   }
 *
 * Responses:
 *   201 — Repository created successfully
 *         { repositoryId, repositoryUrl, cloneUrl, sshUrl, fullName, defaultBranch, resolvedName }
 *   400 — Invalid JSON or invalid request body
 *   401 — Not authenticated
 *   403 — Not authorized for this deployment
 *   404 — Deployment record not found
 *   409 — Name collision after maximum retries
 *   429 — GitHub rate limit exceeded (Retry-After header set)
 *   500 — Unexpected error (auth failure, network error, etc.)
 *
 * Feature: github-repository-creation
 * Issue branch: github-repository-creation
 */

import { NextRequest, NextResponse } from 'next/server';
import { withDeploymentAuth } from '@/lib/api/with-auth';
import { withAuth } from '@/lib/api/with-auth';
import { createClient } from '@/lib/supabase/server';
import { githubService } from '@/services/github.service';
import { githubRepositoryUpdateService } from '@/services/github-repository-update.service';

interface RequestBody {
    private?: boolean;
    description?: string;
    homepage?: string;
    topics?: string[];
}

function normalizeRequestBody(raw: unknown): RequestBody | null {
    if (raw === null || typeof raw !== 'object') {
        return null;
    }

    const body = raw as Record<string, unknown>;

    if ('private' in body && typeof body.private !== 'boolean') {
        return null;
    }

    if ('description' in body && typeof body.description !== 'string') {
        return null;
    }

    if ('homepage' in body && typeof body.homepage !== 'string') {
        return null;
    }

    if (
        'topics' in body &&
        (!Array.isArray(body.topics) || body.topics.some((topic) => typeof topic !== 'string'))
    ) {
        return null;
    }

    return body as RequestBody;
}

/**
 * GET /api/deployments/[id]/repository
 *
 * Retrieves repository metadata for a deployment's linked GitHub repository.
 * Enforces deployment ownership check (not just authentication).
 *
 * Authentication & ownership:
 *   Requires a valid session (401) and ownership of the deployment (404).
 *
 * Responses:
 *   200 — Repository metadata retrieved
 *         { defaultBranch, visibility, lastCommitSha, lastCommitMessage, lastCommitDate }
 *   401 — Not authenticated
 *   404 — Deployment not found or not owned by caller
 *   500 — Unexpected error (GitHub API failure, etc.)
 */
export const GET = withAuth(async (req: NextRequest, { user, supabase, params }) => {
    const deploymentId = params.id;

    const { data: deployment, error: fetchError } = await supabase
        .from('deployments')
        .select('repository_url, user_id')
        .eq('id', deploymentId)
        .single();

    if (fetchError || !deployment) {
        return NextResponse.json({ error: 'Deployment not found' }, { status: 404 });
    }

    if (deployment.user_id !== user.id) {
        return NextResponse.json({ error: 'Deployment not found' }, { status: 404 });
    }

    if (!deployment.repository_url) {
        return NextResponse.json({ error: 'Repository not linked to deployment' }, { status: 404 });
    }

    try {
        const url = new URL(deployment.repository_url);
        const [owner, repo] = url.pathname.replace('.git', '').split('/').slice(-2);

        const metadata = await githubService.getRepositoryMetadata(owner, repo);

        return NextResponse.json(metadata, { status: 200 });
    } catch (err: any) {
        console.error('Failed to fetch repository metadata:', err);
        return NextResponse.json(
            { error: 'Failed to fetch repository metadata' },
            { status: 500 }
        );
    }
});

export const POST = withDeploymentAuth(async (req: NextRequest, { params, supabase, user }) => {
    const deploymentId = params.id;

    let body: RequestBody = {};
    try {
        const raw = await req.json();
        const normalized = normalizeRequestBody(raw);

        if (normalized === null) {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        body = normalized;
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    // Fetch the deployment name used to derive the repository name.
    const { data: deployment, error: fetchError } = await supabase
        .from('deployments')
        .select('name')
        .eq('id', deploymentId)
        .single();

    if (fetchError || !deployment) {
        return NextResponse.json({ error: 'Deployment not found' }, { status: 404 });
    }

    // Signal that repo creation is in progress.
    await supabase
        .from('deployments')
        .update({ status: 'creating_repo', updated_at: new Date().toISOString() })
        .eq('id', deploymentId);

    try {
        const { repository, resolvedName } = await githubService.createRepository({
            name: deployment.name as string,
            description: typeof body.description === 'string' ? body.description : undefined,
            homepage: typeof body.homepage === 'string' ? body.homepage : undefined,
            topics: body.topics,
            private: body.private !== false, // default true
            userId: user.id,
        });

        // Apply branch protection rules to the production branch
        const [owner, repo] = repository.fullName.split('/');
        const protectionResult = await githubService.protectBranch(owner, repo);

        if (!protectionResult.success) {
            // Log the error but don't fail the repository creation
            // Protection can be applied manually if needed
            console.warn(
                `[Repository Creation] Branch protection failed for ${repository.fullName}: ${protectionResult.error}`,
            );
        }

        // Persist the repository URL and advance to the next deployment stage.
        await supabase
            .from('deployments')
            .update({
                repository_url: repository.url,
                status: 'pushing_code',
                updated_at: new Date().toISOString(),
            })
            .eq('id', deploymentId);

        return NextResponse.json(
            {
                repositoryId: repository.id,
                repositoryUrl: repository.url,
                cloneUrl: repository.cloneUrl,
                sshUrl: repository.sshUrl,
                fullName: repository.fullName,
                defaultBranch: repository.defaultBranch,
                resolvedName,
            },
            { status: 201 },
        );
    } catch (err: unknown) {
        const svcErr = err as { code?: string; message?: string; retryAfterMs?: number };

        // Record the failure so the UI can surface it and the deployment can be retried.
        await supabase
            .from('deployments')
            .update({
                status: 'failed',
                error_message: svcErr.message ?? 'Repository creation failed',
                updated_at: new Date().toISOString(),
            })
            .eq('id', deploymentId);

        if (svcErr.code === 'COLLISION') {
            return NextResponse.json(
                { error: svcErr.message ?? 'Repository name collision — all retry attempts exhausted' },
                { status: 409 },
            );
        }

        if (svcErr.code === 'RATE_LIMITED') {
            const response = NextResponse.json(
                { error: 'GitHub API rate limit exceeded — check Retry-After header' },
                { status: 429 },
            );
            if (svcErr.retryAfterMs) {
                response.headers.set(
                    'Retry-After',
                    String(Math.ceil(svcErr.retryAfterMs / 1000)),
                );
            }
            return response;
        }

        return NextResponse.json(
            { error: svcErr.message ?? 'Repository creation failed' },
            { status: 500 },
        );
    }
});

// ---------------------------------------------------------------------------
// PATCH /api/deployments/[id]/repository
//
// Updates the GitHub repository for an existing deployment by regenerating
// files from the new customization config and committing them.
//
// Feature: github-repository-update-flow
// ---------------------------------------------------------------------------

interface UpdateRequestBody {
    customizationConfig: Record<string, unknown>;
    branch?: string;
    commitMessage?: string;
}

function normalizeUpdateRequestBody(raw: unknown): UpdateRequestBody | null {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }

    const body = raw as Record<string, unknown>;

    if (
        !('customizationConfig' in body) ||
        body.customizationConfig === null ||
        typeof body.customizationConfig !== 'object' ||
        Array.isArray(body.customizationConfig)
    ) {
        return null;
    }

    if ('commitMessage' in body && typeof body.commitMessage !== 'string') {
        return null;
    }

    if ('branch' in body && typeof body.branch !== 'string') {
        return null;
    }

    return body as UpdateRequestBody;
}

export const PATCH = withDeploymentAuth(async (req: NextRequest, { params, user }) => {
    const deploymentId = params.id;

    let body: UpdateRequestBody;
    try {
        const raw = await req.json();
        const normalized = normalizeUpdateRequestBody(raw);

        if (normalized === null) {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        body = normalized;
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    try {
        const { commitRef, deploymentId: resultDeploymentId } =
            await githubRepositoryUpdateService.updateRepository({
                deploymentId,
                userId: user.id,
                customizationConfig: body.customizationConfig as any,
                branch: body.branch,
                commitMessage: body.commitMessage,
            });

        return NextResponse.json({
            commitSha: commitRef.commitSha,
            treeSha: commitRef.treeSha,
            commitUrl: commitRef.commitUrl,
            branch: commitRef.branch,
            fileCount: commitRef.fileCount,
            owner: commitRef.owner,
            repo: commitRef.repo,
            deploymentId: resultDeploymentId,
        });
    } catch (err: unknown) {
        const svcErr = err as { code?: string; message?: string; retryAfterMs?: number };

        if (svcErr.code === 'RATE_LIMITED') {
            const response = NextResponse.json(
                { error: svcErr.message ?? 'GitHub API rate limit exceeded' },
                { status: 429 },
            );
            if (svcErr.retryAfterMs) {
                response.headers.set('Retry-After', String(Math.ceil(svcErr.retryAfterMs / 1000)));
            }
            return response;
        }

        if (svcErr.code === 'NETWORK_ERROR') {
            return NextResponse.json(
                { error: svcErr.message ?? 'Network error communicating with GitHub' },
                { status: 502 },
            );
        }

        return NextResponse.json(
            { error: svcErr.message ?? 'Repository update failed' },
            { status: 500 },
        );
    }
});
