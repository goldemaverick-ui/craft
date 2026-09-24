/**
 * DeploymentUpdateService
 *
 * Handles deployment updates with rollback on failure.
 *
 * Property 38 (design.md): Failed updates must NOT replace the last known good deployment.
 * When an update fails at any stage, the deployment must rollback to the previous
 * successful state, preserving:
 *   - The active deployment URL
 *   - The deployment configuration
 *   - The status as 'completed' (not 'failed')
 *
 * This service implements a transactional update pattern with automatic rollback.
 */

import { createClient } from '@/lib/supabase/server';
import type { CustomizationConfig, DeploymentStatusType, GeneratedFile } from '@craft/types';
import {
    githubPushService,
    type GitHubCommitReference,
    type GitHubPushService,
} from './github-push.service';
import { parseRepoIdentity } from './github-repository-update.service';
import {
    BlueGreenSwitcher,
    DEFAULT_CANARY_STEPS,
    RolloutEngine,
    type DeploymentVersion,
} from './rollout-strategy.service';
import {
    VercelService,
    type NormalizedDeploymentStatus,
    type TriggerDeploymentResult,
    type VercelAlias,
} from './vercel.service';

export interface DeploymentUpdate {
    id: string;
    deploymentId: string;
    userId: string;
    newCustomizationConfig: CustomizationConfig;
    status: DeploymentUpdateStatus;
    canaryPercent: number;
    previousState: DeploymentState | null;
    errorMessage?: string;
    createdAt: Date;
    completedAt?: Date;
    canaryPercent?: number;
}

export type DeploymentUpdateStatus =
    | 'pending'
    | 'validating'
    | 'generating'
    | 'updating_repo'
    | 'redeploying'
    | 'completed'
    | 'rolled_back'
    | 'failed';

export interface DeploymentState {
    name: string;
    customizationConfig: CustomizationConfig;
    deploymentUrl: string | null;
    vercelProjectId: string | null;
    vercelDeploymentId: string | null;
    customDomain: string | null;
    status: DeploymentStatusType;
    repositoryUrl: string | null;
}

export interface UpdateDeploymentRequest {
    deploymentId: string;
    userId: string;
    customizationConfig: CustomizationConfig;
    githubPush?: {
        owner: string;
        repo: string;
        token: string;
        branch: string;
        baseBranch?: string;
        commitMessage?: string;
        generatedFiles: GeneratedFile[];
        authorName?: string;
        authorEmail?: string;
    };
}

export interface UpdateDeploymentResult {
    success: boolean;
    deploymentId: string;
    rolledBack: boolean;
    deploymentUrl?: string;
    commitRef?: GitHubCommitReference;
    errorMessage?: string;
}

interface PipelineExecutionResult {
    success: boolean;
    commitRef?: GitHubCommitReference;
    deploymentUrl?: string;
    vercelDeploymentId?: string;
    stagingDeploymentId?: string;
    productionDeploymentId?: string;
    previousProductionDeploymentId?: string;
    canaryPercent: number;
    rollbackReason?: string;
}

export interface RolloutMetrics {
    errorRate: number;
    p99LatencyMs: number;
    forceRollback?: boolean;
}

export interface RolloutMonitorContext {
    updateId: string;
    deploymentId: string;
    candidateDeploymentId: string;
    candidateDeploymentUrl: string;
    canaryPercent: number;
}

export interface RolloutMonitor {
    getCandidateMetrics(context: RolloutMonitorContext): Promise<RolloutMetrics>;
}

interface DeploymentUpdateVercelClient {
    triggerDeployment(projectId: string, gitRepo: string): Promise<TriggerDeploymentResult>;
    getDeploymentStatus(deploymentId: string): Promise<NormalizedDeploymentStatus>;
    listDeploymentAliases(deploymentId: string): Promise<VercelAlias[]>;
    assignAliasToDeployment(deploymentId: string, alias: string): Promise<VercelAlias>;
}

class HttpRolloutMonitor implements RolloutMonitor {
    async getCandidateMetrics(context: RolloutMonitorContext): Promise<RolloutMetrics> {
        const injected = (globalThis as any).__DEPLOYMENT_UPDATE_ROLLOUT_METRICS;
        if (typeof injected === 'function') {
            return injected(context);
        }

        const startedAt = Date.now();
        try {
            const response = await fetch(context.candidateDeploymentUrl, {
                method: 'HEAD',
                signal: AbortSignal.timeout(10_000),
            });

            return {
                errorRate: response.ok ? 0 : 1,
                p99LatencyMs: Date.now() - startedAt,
                forceRollback: (globalThis as any).__DEPLOYMENT_UPDATE_MANUAL_ROLLBACK === true,
            };
        } catch {
            return {
                errorRate: 1,
                p99LatencyMs: 10_000,
                forceRollback: (globalThis as any).__DEPLOYMENT_UPDATE_MANUAL_ROLLBACK === true,
            };
        }
    }
}

export class DeploymentUpdateService {
    constructor(
        private readonly _githubPushService: Pick<GitHubPushService, 'pushGeneratedCode'> = githubPushService,
        private readonly _vercelService: DeploymentUpdateVercelClient = new VercelService(),
        private readonly _rolloutMonitor: RolloutMonitor = new HttpRolloutMonitor(),
    ) {}

    /**
     * Update a deployment with new customization config.
     * If the update fails, automatically rollback to the previous good state.
     */
    async updateDeployment(request: UpdateDeploymentRequest): Promise<UpdateDeploymentResult> {
        const { deploymentId, userId, customizationConfig, githubPush } = request;
        const updateId = crypto.randomUUID();

        try {
            const previousState = await this.getDeploymentState(deploymentId, userId);

            if (!previousState) {
                return {
                    success: false,
                    deploymentId,
                    rolledBack: false,
                    errorMessage: 'Deployment not found or access denied',
                };
            }

            if (previousState.status !== 'completed') {
                return {
                    success: false,
                    deploymentId,
                    rolledBack: false,
                    errorMessage: `Cannot update deployment in '${previousState.status}' state`,
                };
            }

            await this.createUpdateRecord(updateId, deploymentId, userId, customizationConfig, previousState);
            await this.validateUpdate(updateId, customizationConfig);

            const pipeline = await this.executeUpdatePipeline(
                updateId,
                deploymentId,
                customizationConfig,
                githubPush,
                previousState,
            );

            if (!pipeline.success) {
                throw new Error(pipeline.rollbackReason || 'Update pipeline failed');
            }

            await this.finalizeUpdate(deploymentId, customizationConfig, pipeline);
            await this.markUpdateCompleted(updateId);

            return {
                success: true,
                deploymentId,
                rolledBack: false,
                deploymentUrl: pipeline.deploymentUrl ?? previousState.deploymentUrl ?? undefined,
                commitRef: pipeline.commitRef,
            };
        } catch (error: any) {
            console.error('Deployment update failed, initiating rollback:', error);

            const rollbackSuccess = await this.rollbackUpdate(updateId, deploymentId);

            return {
                success: false,
                deploymentId,
                rolledBack: rollbackSuccess,
                errorMessage: error.message || 'Deployment update failed',
            };
        }
    }

    private async getDeploymentState(
        deploymentId: string,
        userId: string,
    ): Promise<DeploymentState | null> {
        const supabase = createClient();

        const { data: deployment, error } = await supabase
            .from('deployments')
            .select('name, customization_config, deployment_url, vercel_project_id, vercel_deployment_id, custom_domain, status, repository_url')
            .eq('id', deploymentId)
            .eq('user_id', userId)
            .single();

        if (error || !deployment) {
            return null;
        }

        return {
            name: deployment.name,
            customizationConfig: deployment.customization_config as CustomizationConfig,
            deploymentUrl: deployment.deployment_url,
            vercelProjectId: deployment.vercel_project_id ?? null,
            vercelDeploymentId: deployment.vercel_deployment_id,
            customDomain: deployment.custom_domain ?? null,
            status: deployment.status as DeploymentStatusType,
            repositoryUrl: deployment.repository_url ?? null,
        };
    }

    private async createUpdateRecord(
        updateId: string,
        deploymentId: string,
        userId: string,
        newConfig: CustomizationConfig,
        previousState: DeploymentState,
    ): Promise<void> {
        const supabase = createClient();

        await supabase.from('deployment_updates').insert({
            id: updateId,
            deployment_id: deploymentId,
            user_id: userId,
            new_customization_config: newConfig,
            previous_state: previousState,
            status: 'pending',
            canary_percent: 0,
            created_at: new Date().toISOString(),
        });
    }

    private async validateUpdate(
        updateId: string,
        config: CustomizationConfig,
    ): Promise<void> {
        await this.updateUpdateStatus(updateId, 'validating', { canaryPercent: 0 });

        if (!config.branding?.appName || config.branding.appName.length === 0) {
            throw new Error('Invalid configuration: appName is required');
        }

        if (!config.stellar?.network || !['mainnet', 'testnet'].includes(config.stellar.network)) {
            throw new Error('Invalid configuration: network must be "mainnet" or "testnet"');
        }
    }

    private async executeUpdatePipeline(
        updateId: string,
        deploymentId: string,
        config: CustomizationConfig,
        githubPush?: UpdateDeploymentRequest['githubPush'],
        previousState?: DeploymentState,
    ): Promise<PipelineExecutionResult> {
        await this.updateUpdateStatus(updateId, 'generating', { canaryPercent: 0 });
        await this.simulateWork();

        await this.updateUpdateStatus(updateId, 'updating_repo', { canaryPercent: 0 });

        let commitRef: GitHubCommitReference | undefined;
        let repoFullName: string | undefined;

        if (githubPush) {
            repoFullName = `${githubPush.owner}/${githubPush.repo}`;
            commitRef = await this._githubPushService.pushGeneratedCode({
                owner: githubPush.owner,
                repo: githubPush.repo,
                token: githubPush.token,
                files: githubPush.generatedFiles,
                branch: githubPush.branch,
                baseBranch: githubPush.baseBranch,
                commitMessage:
                    githubPush.commitMessage ||
                    `chore: update generated workspace (${new Date().toISOString()})`,
                authorName: githubPush.authorName,
                authorEmail: githubPush.authorEmail,
            });
        } else if (previousState?.repositoryUrl) {
            const { owner, repo } = parseRepoIdentity(previousState.repositoryUrl);
            repoFullName = `${owner}/${repo}`;
            const token = process.env.GITHUB_TOKEN ?? '';
            commitRef = await this._githubPushService.pushGeneratedCode({
                owner,
                repo,
                token,
                files: [],
                branch: 'main',
                commitMessage: `chore: update generated workspace (${new Date().toISOString()})`,
            });
        } else {
            await this.simulateWork();
        }

        await this.updateUpdateStatus(updateId, 'redeploying', { canaryPercent: 0 });

        const shouldFail = (globalThis as any).__DEPLOYMENT_UPDATE_SHOULD_FAIL === true;
        if (shouldFail) {
            return {
                success: false,
                commitRef,
                canaryPercent: 0,
                rollbackReason: 'Update pipeline failed',
            };
        }

        if (!previousState?.vercelProjectId || !repoFullName) {
            await this.simulateWork();
            return {
                success: true,
                commitRef,
                deploymentUrl: previousState?.deploymentUrl ?? undefined,
                vercelDeploymentId: previousState?.vercelDeploymentId ?? undefined,
                canaryPercent: 0,
            };
        }

        const candidate = await this._vercelService.triggerDeployment(
            previousState.vercelProjectId,
            repoFullName,
        );
        const candidateStatus = await this._vercelService.getDeploymentStatus(candidate.deploymentId);

        const stagingDeploymentId = candidate.deploymentId;

        if (candidateStatus.status === 'failed' || candidateStatus.status === 'canceled') {
            return {
                success: false,
                commitRef,
                deploymentUrl: candidate.deploymentUrl,
                vercelDeploymentId: candidate.deploymentId,
                stagingDeploymentId,
                canaryPercent: 0,
                rollbackReason: 'Candidate deployment did not become ready',
            };
        }

        const stableVersion: DeploymentVersion = {
            id: previousState.vercelDeploymentId ?? 'stable',
            errorRate: 0,
            p99LatencyMs: 0,
        };
        const candidateVersion: DeploymentVersion = {
            id: candidate.deploymentId,
            errorRate: 0,
            p99LatencyMs: 0,
        };
        const rollout = new RolloutEngine(stableVersion, candidateVersion);

        for (const canaryPercent of DEFAULT_CANARY_STEPS) {
            rollout.setTrafficPercent(canaryPercent);
            await this.updateUpdateStatus(updateId, 'redeploying', { canaryPercent });

            const metrics = await this._rolloutMonitor.getCandidateMetrics({
                updateId,
                deploymentId,
                candidateDeploymentId: candidate.deploymentId,
                candidateDeploymentUrl: candidate.deploymentUrl,
                canaryPercent,
            });

            candidateVersion.errorRate = metrics.errorRate;
            candidateVersion.p99LatencyMs = metrics.p99LatencyMs;

            if (metrics.forceRollback || rollout.evaluateAndMaybeRollback()) {
                return {
                    success: false,
                    commitRef,
                    deploymentUrl: candidate.deploymentUrl,
                    vercelDeploymentId: candidate.deploymentId,
                    stagingDeploymentId,
                    canaryPercent: 0,
                    rollbackReason: metrics.forceRollback
                        ? 'Manual rollback requested during rollout'
                        : 'Automatic rollback triggered during rollout',
                };
            }
        }

        const switcher = new BlueGreenSwitcher(stableVersion, candidateVersion, 'blue');
        if (!switcher.switchToStandby()) {
            return {
                success: false,
                commitRef,
                deploymentUrl: candidate.deploymentUrl,
                vercelDeploymentId: candidate.deploymentId,
                stagingDeploymentId,
                canaryPercent: 0,
                rollbackReason: 'Candidate failed blue-green promotion health gate',
            };
        }

        const aliases = await this.getPromotionAliases(previousState);
        if (previousState.vercelDeploymentId && aliases.length > 0) {
            await this.switchAliasesWithRollback(previousState.vercelDeploymentId, candidate.deploymentId, aliases);
        }

        rollout.promote();
        await this.updateUpdateStatus(updateId, 'redeploying', { canaryPercent: 100 });

        return {
            success: true,
            commitRef,
            deploymentUrl: candidate.deploymentUrl,
            vercelDeploymentId: candidate.deploymentId,
            stagingDeploymentId: null,
            productionDeploymentId: candidate.deploymentId,
            previousProductionDeploymentId: previousState?.vercelDeploymentId ?? undefined,
            canaryPercent: 100,
        };
    }

    private async finalizeUpdate(
        deploymentId: string,
        config: CustomizationConfig,
        pipeline: PipelineExecutionResult,
    ): Promise<void> {
        const supabase = createClient();

        const updatePayload: Record<string, any> = {
            customization_config: config,
            deployment_url: pipeline.deploymentUrl,
            vercel_deployment_id: pipeline.vercelDeploymentId,
            status: 'completed',
            updated_at: new Date().toISOString(),
        };

        if ('stagingDeploymentId' in pipeline) {
            updatePayload.staging_deployment_id = pipeline.stagingDeploymentId;
        }
        if ('productionDeploymentId' in pipeline) {
            updatePayload.production_deployment_id = pipeline.productionDeploymentId;
        }
        if ('previousProductionDeploymentId' in pipeline) {
            updatePayload.previous_production_deployment_id = pipeline.previousProductionDeploymentId;
        }

        await supabase
            .from('deployments')
            .update(updatePayload)
            .eq('id', deploymentId);
    }

    /**
     * Rollback to the previous deployment state.
     * Idempotent — calling it on an already-rolled-back record is a no-op.
     */
    async rollbackUpdate(
        updateId: string,
        deploymentId: string,
    ): Promise<boolean> {
        try {
            const supabase = createClient();

            const { data: updateRecord } = await supabase
                .from('deployment_updates')
                .select('previous_state, status')
                .eq('id', updateId)
                .single();

            // Idempotency: already rolled back — no-op
            if (updateRecord?.status === 'rolled_back') {
                return true;
            }

            if (!updateRecord?.previous_state) {
                console.error('No previous state found for rollback');
                return false;
            }

            const previousState = updateRecord.previous_state as DeploymentState;

            await supabase
                .from('deployments')
                .update({
                    customization_config: previousState.customizationConfig,
                    deployment_url: previousState.deploymentUrl,
                    vercel_deployment_id: previousState.vercelDeploymentId,
                    production_deployment_id: previousState.vercelDeploymentId,
                    staging_deployment_id: null,
                    status: 'completed',
                    error_message: null,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', deploymentId);

            await this.updateUpdateStatus(updateId, 'rolled_back', { canaryPercent: 0 });

            console.log(`Successfully rolled back deployment ${deploymentId}`);
            return true;
        } catch (error: any) {
            console.error('Rollback failed:', error);
            await this.updateUpdateStatus(updateId, 'failed', { canaryPercent: 0 });
            return false;
        }
    }

    private async updateUpdateStatus(
        updateId: string,
        status: DeploymentUpdateStatus,
        options: { canaryPercent?: number; errorMessage?: string } = {},
    ): Promise<void> {
        const supabase = createClient();

        await supabase
            .from('deployment_updates')
            .update({
                status,
                ...(options.canaryPercent !== undefined ? { canary_percent: options.canaryPercent } : {}),
                ...(options.errorMessage !== undefined ? { error_message: options.errorMessage } : {}),
                updated_at: new Date().toISOString(),
            })
            .eq('id', updateId);
    }

    private async markUpdateCompleted(updateId: string): Promise<void> {
        const supabase = createClient();

        await supabase
            .from('deployment_updates')
            .update({
                status: 'completed',
                canary_percent: 100,
                completed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', updateId);
    }

    private async getPromotionAliases(previousState: DeploymentState): Promise<string[]> {
        const aliases = new Set<string>();

        if (previousState.vercelDeploymentId) {
            const activeAliases = await this._vercelService.listDeploymentAliases(previousState.vercelDeploymentId);
            for (const alias of activeAliases) {
                aliases.add(alias.alias);
            }
        }

        if (aliases.size === 0 && previousState.customDomain) {
            aliases.add(previousState.customDomain);
        }

        return [...aliases];
    }

    private async switchAliasesWithRollback(
        previousDeploymentId: string,
        candidateDeploymentId: string,
        aliases: string[],
    ): Promise<void> {
        const switched: string[] = [];

        try {
            for (const alias of aliases) {
                await this._vercelService.assignAliasToDeployment(candidateDeploymentId, alias);
                switched.push(alias);
            }
        } catch (error) {
            for (const alias of switched.reverse()) {
                try {
                    await this._vercelService.assignAliasToDeployment(previousDeploymentId, alias);
                } catch (rollbackError) {
                    console.error('Failed to revert alias after promotion error:', rollbackError);
                }
            }
            throw error;
        }
    }

    private async simulateWork(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    async getUpdateHistory(deploymentId: string): Promise<Array<{
        id: string;
        status: DeploymentUpdateStatus;
        rolledBack: boolean;
        canaryPercent: number;
        errorMessage?: string;
        createdAt: Date;
        completedAt?: Date;
    }>> {
        const supabase = createClient();

        const { data, error } = await supabase
            .from('deployment_updates')
            .select('id, status, canary_percent, error_message, created_at, completed_at')
            .eq('deployment_id', deploymentId)
            .order('created_at', { ascending: false });

        if (error) {
            return [];
        }

        return (data || []).map((record: any) => ({
            id: record.id,
            status: record.status as DeploymentUpdateStatus,
            rolledBack: record.status === 'rolled_back',
            canaryPercent: record.canary_percent ?? 0,
            errorMessage: record.error_message ?? undefined,
            createdAt: new Date(record.created_at),
            completedAt: record.completed_at ? new Date(record.completed_at) : undefined,
        }));
    }
}

export const deploymentUpdateService = new DeploymentUpdateService();
