import { Module } from '@nestjs/common';
import { ProxyController } from './proxy.controller';
import { TunnelGateway } from './tunnel.gateway';
import { TunnelService } from './tunnel.service';

@Module({
  controllers: [ProxyController],
  providers: [TunnelGateway, TunnelService],
  exports: [TunnelService],
})
export class TunnelModule {}
