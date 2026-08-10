import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PLUGIN_CATALOG, isValidPluginKey } from './catalog';

/**
 * The entitlement seam. Everything that gates a niche feature on a pack goes
 * through here — `isEnabled` is what future packs (Hifz, code board, …) call.
 */
@Injectable()
export class PluginsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The catalog annotated with each pack's enabled state for this org. */
  async listForOrg(orgId: string) {
    const enabled = await this.enabledKeys(orgId);
    return PLUGIN_CATALOG.map((p) => ({ ...p, enabled: enabled.has(p.key) }));
  }

  /** Set of pluginKeys this org has turned on. */
  async enabledKeys(orgId: string): Promise<Set<string>> {
    const rows = await this.prisma.orgPlugin.findMany({
      where: { organizationId: orgId },
      select: { pluginKey: true },
    });
    return new Set(rows.map((r) => r.pluginKey));
  }

  /** Guard helper for feature code: is this pack on for this org? */
  async isEnabled(orgId: string | null, key: string): Promise<boolean> {
    if (!orgId) return false;
    const row = await this.prisma.orgPlugin.findUnique({
      where: { organizationId_pluginKey: { organizationId: orgId, pluginKey: key } },
      select: { id: true },
    });
    return row !== null;
  }

  async enable(orgId: string, key: string) {
    if (!isValidPluginKey(key)) throw new BadRequestException('Unknown plugin');
    // Idempotent: enabling an already-on pack is a no-op.
    await this.prisma.orgPlugin.upsert({
      where: { organizationId_pluginKey: { organizationId: orgId, pluginKey: key } },
      create: { organizationId: orgId, pluginKey: key },
      update: {},
    });
    return { key, enabled: true };
  }

  async disable(orgId: string, key: string) {
    if (!isValidPluginKey(key)) throw new BadRequestException('Unknown plugin');
    await this.prisma.orgPlugin.deleteMany({
      where: { organizationId: orgId, pluginKey: key },
    });
    return { key, enabled: false };
  }
}
