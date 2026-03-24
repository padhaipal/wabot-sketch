import { Module } from '@nestjs/common';
import { AcceptController } from './interfaces/whatsapp/inbound/accept/accept.controller.js';
import { AcceptService } from './interfaces/whatsapp/inbound/accept/accept.service.js';

@Module({
  controllers: [AcceptController],
  providers: [AcceptService],
})
export class AppModule {}
