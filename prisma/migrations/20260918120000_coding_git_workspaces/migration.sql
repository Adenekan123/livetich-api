-- Coding Instructor: GitHub-backed student workspaces.
--
-- Additive only. Every new column is nullable or defaulted, so the existing
-- ZIP-archive submission path keeps working untouched while the commit-backed
-- path is built alongside it.

-- ---------------------------------------------------------------------------
-- Short codes that name a repository without using the student's name (§6).
-- Nullable: only coding programs ever need one.
-- ---------------------------------------------------------------------------
ALTER TABLE `Course` ADD COLUMN `code` VARCHAR(16) NULL;

-- Scoped to the tenant, so two workspaces may both use "FE". MySQL treats
-- NULLs as distinct in a unique index, so untouched courses do not collide.
CREATE UNIQUE INDEX `Course_organizationId_code_key` ON `Course`(`organizationId`, `code`);

-- The stable half of the repository name. Allocated on demand, not at enrolment.
ALTER TABLE `Enrollment` ADD COLUMN `no` INTEGER NULL;
CREATE UNIQUE INDEX `Enrollment_courseId_no_key` ON `Enrollment`(`courseId`, `no`);

-- Where a task's work lives inside the student's repository.
ALTER TABLE `CodingAssignment` ADD COLUMN `workspacePath` VARCHAR(255) NULL;

-- ---------------------------------------------------------------------------
-- The student's GitHub identity, connected once from the editor (§9).
--
-- Personal rather than per-workspace: one person, one GitHub account, however
-- many institutions they study with. Both columns are unique because granting
-- repository access is keyed on them — two Livetich accounts claiming the same
-- GitHub user would mean one student holding push access to another's work.
-- ---------------------------------------------------------------------------
ALTER TABLE `User`
    ADD COLUMN `githubLogin` VARCHAR(100) NULL,
    ADD COLUMN `githubUserId` VARCHAR(32) NULL,
    ADD COLUMN `githubConnectedAt` DATETIME(3) NULL;

CREATE UNIQUE INDEX `User_githubLogin_key` ON `User`(`githubLogin`);
CREATE UNIQUE INDEX `User_githubUserId_key` ON `User`(`githubUserId`);

-- ---------------------------------------------------------------------------
-- A tenant's GitHub organisation connection.
--
-- Deliberately holds no token: installation tokens are minted per request from
-- the App private key and expire in an hour, so there is nothing here worth
-- stealing beyond public identifiers.
-- ---------------------------------------------------------------------------
CREATE TABLE `GitHubOrganizationConnection` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `githubInstallationId` VARCHAR(32) NOT NULL,
    `githubOrganizationId` VARCHAR(32) NULL,
    `githubOrganizationLogin` VARCHAR(100) NOT NULL,
    `status` ENUM('ACTIVE', 'SUSPENDED', 'REVOKED') NOT NULL DEFAULT 'ACTIVE',
    `connectedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `GitHubOrganizationConnection_organizationId_key`(`organizationId`),
    INDEX `GitHubOrganizationConnection_githubInstallationId_idx`(`githubInstallationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Per-program git configuration. Its presence marks a program coding-enabled.
-- ---------------------------------------------------------------------------
CREATE TABLE `CodingProgramGitConfig` (
    `id` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `connectionId` VARCHAR(191) NOT NULL,
    `templateRepositoryId` VARCHAR(32) NULL,
    `templateRepositoryName` VARCHAR(100) NULL,
    `defaultBranch` VARCHAR(100) NOT NULL DEFAULT 'main',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CodingProgramGitConfig_courseId_key`(`courseId`),
    INDEX `CodingProgramGitConfig_connectionId_idx`(`connectionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- One private repository per coding-program enrolment.
--
-- The unique key on enrollmentId is the idempotency guarantee: a second
-- "Start Coding Workspace" can only find the existing row, so a retry can
-- never produce fe-sep26-enr1042-2 (§39).
-- ---------------------------------------------------------------------------
CREATE TABLE `CodingEnrollmentWorkspace` (
    `id` VARCHAR(191) NOT NULL,
    `enrollmentId` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `githubRepositoryId` VARCHAR(32) NULL,
    `githubRepositoryName` VARCHAR(100) NULL,
    `githubRepositoryFullName` VARCHAR(200) NULL,
    `defaultBranch` VARCHAR(100) NOT NULL DEFAULT 'main',
    `status` ENUM('NOT_CREATED', 'PROVISIONING', 'ACTIVE', 'ARCHIVED', 'WITHDRAWN', 'ERROR') NOT NULL DEFAULT 'NOT_CREATED',
    `lastError` TEXT NULL,
    `lastSyncedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `archivedAt` DATETIME(3) NULL,

    UNIQUE INDEX `CodingEnrollmentWorkspace_enrollmentId_key`(`enrollmentId`),
    INDEX `CodingEnrollmentWorkspace_courseId_idx`(`courseId`),
    INDEX `CodingEnrollmentWorkspace_studentId_idx`(`studentId`),
    INDEX `CodingEnrollmentWorkspace_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Submissions gain a Git identity alongside the archive one.
--
-- activityType defaults to ASSIGNMENT so every existing row keeps its meaning;
-- commitSha is indexed because "what exactly was submitted" is looked up by it.
-- ---------------------------------------------------------------------------
ALTER TABLE `CodingSubmission`
    ADD COLUMN `activityType` ENUM('ASSIGNMENT', 'LIVE_EXERCISE', 'COMPETITION') NOT NULL DEFAULT 'ASSIGNMENT',
    ADD COLUMN `workspaceId` VARCHAR(191) NULL,
    ADD COLUMN `commitSha` VARCHAR(40) NULL;

CREATE INDEX `CodingSubmission_workspaceId_idx` ON `CodingSubmission`(`workspaceId`);
CREATE INDEX `CodingSubmission_commitSha_idx` ON `CodingSubmission`(`commitSha`);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------
ALTER TABLE `GitHubOrganizationConnection`
    ADD CONSTRAINT `GitHubOrganizationConnection_organizationId_fkey`
    FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CodingProgramGitConfig`
    ADD CONSTRAINT `CodingProgramGitConfig_courseId_fkey`
    FOREIGN KEY (`courseId`) REFERENCES `Course`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CodingProgramGitConfig`
    ADD CONSTRAINT `CodingProgramGitConfig_connectionId_fkey`
    FOREIGN KEY (`connectionId`) REFERENCES `GitHubOrganizationConnection`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `CodingEnrollmentWorkspace`
    ADD CONSTRAINT `CodingEnrollmentWorkspace_enrollmentId_fkey`
    FOREIGN KEY (`enrollmentId`) REFERENCES `Enrollment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CodingEnrollmentWorkspace`
    ADD CONSTRAINT `CodingEnrollmentWorkspace_courseId_fkey`
    FOREIGN KEY (`courseId`) REFERENCES `Course`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `CodingEnrollmentWorkspace`
    ADD CONSTRAINT `CodingEnrollmentWorkspace_studentId_fkey`
    FOREIGN KEY (`studentId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Kept RESTRICT: a workspace row is grading evidence, and a submission must
-- never be able to outlive the workspace it names without anyone noticing.
ALTER TABLE `CodingSubmission`
    ADD CONSTRAINT `CodingSubmission_workspaceId_fkey`
    FOREIGN KEY (`workspaceId`) REFERENCES `CodingEnrollmentWorkspace`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
