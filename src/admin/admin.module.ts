import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminStepUpGuard } from './admin-step-up.guard';
import { SuperAdminGuard } from './super-admin.guard';

/**
 * Platform-operator console. Reuses AuthService (reset links) and the global
 * JwtService / AuthCacheService / AuditService / PrismaService, so it only needs
 * to import AuthModule for AuthService.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminController],
  providers: [AdminService, SuperAdminGuard, AdminStepUpGuard],
})
export class AdminModule {}
