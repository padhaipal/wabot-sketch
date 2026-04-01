import { Module } from '@nestjs/common';
import { AcceptController } from './interfaces/whatsapp/inbound/accept/accept.controller.js';
import { AcceptService } from './interfaces/whatsapp/inbound/accept/accept.service.js';
import { PpInboundController } from './interfaces/pp/inbound/inbound.controller.js';

@Module({
  controllers: [AcceptController, PpInboundController],
  providers: [AcceptService],
})
export class AppModule {}
