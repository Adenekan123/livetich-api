import { Module } from '@nestjs/common';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';

@Module({
  controllers: [PluginsController],
  providers: [PluginsService],
  exports: [PluginsService], // future packs gate features via PluginsService.isEnabled
})
export class PluginsModule {}
