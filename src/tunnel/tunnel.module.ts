import { Module } from '@nestjs/common';
import { ProxyController } from './proxy.controller';
import { TunnelGateway } from './tunnel.gateway';
import { TunnelService } from './tunnel.service';
import { PreviewWebSocketService } from './preview-websocket.service';

@Module({
  controllers: [ProxyController],
  providers: [TunnelGateway, TunnelService, PreviewWebSocketService],
  exports: [TunnelService],
})
export class TunnelModule {}
