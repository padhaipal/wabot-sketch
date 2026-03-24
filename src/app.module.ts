import { Module } from '@nestjs/common';
import { AcceptController } from './interfaces/whatsapp/inbound/accept/accept.controller';
import { AcceptService } from './interfaces/whatsapp/inbound/accept/accept.service';

@Module({
  controllers: [AcceptController],
  providers: [AcceptService],
})
export class AppModule {}
