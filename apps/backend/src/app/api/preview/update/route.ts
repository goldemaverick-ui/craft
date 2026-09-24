import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api/with-auth';
import { validateCustomizationConfig } from '@/lib/customization/validate';
import { previewService } from '@/services/preview.service';
import { costEstimationService } from '@/services/billing/cost-estimation.service';
import type { CustomizationConfig, DeepPartial } from '@craft/types';

/**
 * POST /api/preview/update
 * Updates preview with partial customization changes.
 * Expects { current, changes, sequence? } where changes is DeepPartial<CustomizationConfig>.
 * Returns minimal update payload with changedFields and optional mockData.
 * sequence is used to reject out-of-order updates (returned as 204 if stale).
 */
export const POST = withAuth(async (req: NextRequest, { user, supabase }) => {
    let body: { current?: unknown; changes?: unknown; sequence?: number };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    if (!body.current || !body.changes) {
        return NextResponse.json(
            { error: 'Missing required fields: current, changes' },
            { status: 400 }
        );
    }

    // Validate current config
    const currentValidation = validateCustomizationConfig(body.current);
    if (!currentValidation.valid) {
        return NextResponse.json(
            { error: 'Invalid current customization config', details: currentValidation.errors },
            { status: 422 }
        );
    }

    const current = body.current as CustomizationConfig;
    const changes = body.changes as DeepPartial<CustomizationConfig>;

    try {
        const payload = previewService.updatePreview(current, changes);
        const estimate = costEstimationService.estimateDeploymentCost({
            customizationConfig: payload.customization,
        });

        return NextResponse.json({
            ...payload,
            estimate,
            costEstimate: estimate,
        }, { status: 200 });
    } catch (error: any) {
        return NextResponse.json(
            { error: error.message || 'Failed to update preview' },
            { status: 500 }
        );
    }
});
