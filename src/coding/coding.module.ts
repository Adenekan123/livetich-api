import { Module } from '@nestjs/common';
import { CoursesModule } from '../courses/courses.module';
import { GitHubModule } from '../github/github.module';
import { CodingController } from './coding.controller';
import { CodingService } from './coding.service';
import { CodingSubmissionsService } from './coding-submissions.service';
import { CodingAiReviewService } from './coding-ai-review.service';
import { CodingInstructorService } from './coding-instructor.service';
import { CodingLiveService } from './coding-live.service';
import { CodingWorkspaceController } from './git/coding-workspace.controller';
import { CodingWorkspaceService } from './git/coding-workspace.service';
import { GitHubConnectionController } from './git/github-connection.controller';
import { GitHubConnectionService } from './git/github-connection.service';
import { GitHubIdentityController } from './git/github-identity.controller';
import { GitHubIdentityService } from './git/github-identity.service';
import { ReviewSourceService } from './git/review-source.service';

/**
 * Coding Instructor Plugin. Covers assignment authoring & delivery, the ZIP
 * submission pipeline, the Gemini AI review, the instructor dashboard /
 * feedback / decision flow, and the GitHub-backed student workspaces.
 *
 * Object storage and the audit trail are global providers, so neither is
 * imported here; GitHubModule is not, and is.
 */
@Module({
  imports: [CoursesModule, GitHubModule],
  controllers: [
    CodingController,
    CodingWorkspaceController,
    GitHubConnectionController,
    GitHubIdentityController,
  ],
  providers: [
    CodingService,
    CodingSubmissionsService,
    CodingAiReviewService,
    CodingInstructorService,
    CodingLiveService,
    CodingWorkspaceService,
    GitHubConnectionService,
    GitHubIdentityService,
    ReviewSourceService,
  ],
  exports: [
    CodingService,
    CodingSubmissionsService,
    CodingAiReviewService,
    CodingInstructorService,
    // Exported because pinning a submission to a commit needs the workspace
    // that commit lives in.
    CodingWorkspaceService,
  ],
})
export class CodingModule {}
