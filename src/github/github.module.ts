import { Module } from '@nestjs/common';
import { GitHubApiService } from './github-api.service';
import { GitHubAppService } from './github-app.service';

/**
 * GitHub App access, with no knowledge of Livetich's domain.
 *
 * Deliberately tenant-agnostic: it knows how to act as an installation, not
 * which organisation owns which course. Everything that maps a student to a
 * repository lives in the coding module, so this stays a thin, auditable seam
 * over one external service — and a future provider could be swapped behind
 * the same two services without touching provisioning logic.
 */
@Module({
  providers: [GitHubAppService, GitHubApiService],
  exports: [GitHubAppService, GitHubApiService],
})
export class GitHubModule {}
