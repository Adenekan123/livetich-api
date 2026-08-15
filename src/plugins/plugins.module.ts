import { Global, Module } from '@nestjs/common';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';
import { RequirePluginGuard } from './require-plugin.guard';

/** Global so the entitlement seam (PluginsService) and the RequirePluginGuard
 *  are injectable anywhere a pack gates a feature, without per-module imports. */
@Global()
@Module({
  controllers: [PluginsController],
  providers: [PluginsService, RequirePluginGuard],
  exports: [PluginsService, RequirePluginGuard],
})
export class PluginsModule {}
