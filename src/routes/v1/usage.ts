import { Hono } from 'hono';
import { z } from 'zod';
import { DatabaseService } from '../../services/database';
import { usage } from '../../db/schema';
import { sql, eq, and } from 'drizzle-orm';

const summarySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export function createUsageRoutes(db: DatabaseService) {
  const app = new Hono();

  app.get('/summary', async (c) => {
    try {
      const query = c.req.query();
      const params = summarySchema.parse(query);

      const filters = {
        userId: c.get('userId'),
        apiKey: c.get('apiKey'),
        startDate: params.startDate ? new Date(params.startDate) : undefined,
        endDate: params.endDate ? new Date(params.endDate) : undefined,
      };

      const summary = await db.getUsageSummary(filters);

      return c.json({
        summary: {
          totalDocuments: summary.totalDocuments || 0,
          totalOperations: summary.totalOperations || 0,
          totalInputTokens: summary.totalInputTokens || 0,
          totalOutputTokens: summary.totalOutputTokens || 0,
          totalCostCents: summary.totalCostCents || 0,
          totalCostUSD: ((summary.totalCostCents || 0) / 100).toFixed(2),
        },
        filters: {
          startDate: filters.startDate?.toISOString(),
          endDate: filters.endDate?.toISOString(),
        },
      });

    } catch (error) {
      console.error('Usage summary error:', error);
      return c.json({ error: 'Failed to retrieve usage summary' }, 500);
    }
  });

  app.get('/breakdown', async (c) => {
    try {
      const breakdown = await db.db.select({
        operation: usage.operation,
        count: sql<number>`count(*)`,
        totalInputTokens: sql<number>`sum(${usage.inputTokens})`,
        totalOutputTokens: sql<number>`sum(${usage.outputTokens})`,
        totalCostCents: sql<number>`sum(${usage.totalCostCents})`,
      })
      .from(usage)
      .where(
        and(
          c.get('userId') ? eq(usage.userId, c.get('userId')) : undefined,
          c.get('apiKey') ? eq(usage.apiKey, c.get('apiKey')) : undefined,
        )
      )
      .groupBy(usage.operation);

      return c.json({
        breakdown: breakdown.map(item => ({
          operation: item.operation,
          count: item.count || 0,
          totalInputTokens: item.totalInputTokens || 0,
          totalOutputTokens: item.totalOutputTokens || 0,
          totalCostCents: item.totalCostCents || 0,
          totalCostUSD: ((item.totalCostCents || 0) / 100).toFixed(2),
        })),
      });

    } catch (error) {
      console.error('Usage breakdown error:', error);
      return c.json({ error: 'Failed to retrieve usage breakdown' }, 500);
    }
  });

  return app;
}