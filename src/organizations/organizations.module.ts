import { Module } from '@nestjs/common';
import {
  InvitesController,
  OrganizationsController,
} from './organizations.controller';
import { OrganizationsService } from './organizations.service';

@Module({
  controllers: [OrganizationsController, InvitesController],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
