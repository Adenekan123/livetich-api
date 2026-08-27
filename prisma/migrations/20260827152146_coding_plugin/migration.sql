-- CreateTable
CREATE TABLE `CodingAssignment` (
    `id` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `language` VARCHAR(191) NULL,
    `framework` VARCHAR(191) NULL,
    `difficulty` VARCHAR(191) NULL,
    `starterFileUrl` VARCHAR(191) NULL,
    `status` ENUM('DRAFT', 'LIVE', 'CLOSED') NOT NULL DEFAULT 'DRAFT',
    `dueAt` DATETIME(3) NULL,
    `timeLimitSec` INTEGER NULL,
    `maxAttempts` INTEGER NOT NULL DEFAULT 3,
    `allowResubmit` BOOLEAN NOT NULL DEFAULT true,
    `keepHighest` BOOLEAN NOT NULL DEFAULT true,
    `passingScore` INTEGER NOT NULL DEFAULT 70,
    `aiAutoReview` BOOLEAN NOT NULL DEFAULT true,
    `showAiToStudents` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CodingAssignment_courseId_idx`(`courseId`),
    INDEX `CodingAssignment_sessionId_idx`(`sessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CodingRequirement` (
    `id` VARCHAR(191) NOT NULL,
    `assignmentId` VARCHAR(191) NOT NULL,
    `order` INTEGER NOT NULL,
    `text` TEXT NOT NULL,
    `mandatory` BOOLEAN NOT NULL DEFAULT false,

    INDEX `CodingRequirement_assignmentId_idx`(`assignmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CodingRubricItem` (
    `id` VARCHAR(191) NOT NULL,
    `assignmentId` VARCHAR(191) NOT NULL,
    `order` INTEGER NOT NULL,
    `criterion` VARCHAR(191) NOT NULL,
    `weight` INTEGER NOT NULL,
    `mandatory` BOOLEAN NOT NULL DEFAULT false,
    `aiInstructions` TEXT NULL,

    INDEX `CodingRubricItem_assignmentId_idx`(`assignmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CodingSubmission` (
    `id` VARCHAR(191) NOT NULL,
    `assignmentId` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `attemptNumber` INTEGER NOT NULL DEFAULT 1,
    `archiveUrl` VARCHAR(191) NULL,
    `archiveHash` VARCHAR(191) NULL,
    `status` ENUM('SUBMITTED', 'UNDER_REVIEW', 'AI_REVIEWED', 'NEEDS_REVIEW', 'PASSED', 'FAILED', 'RETURNED') NOT NULL DEFAULT 'SUBMITTED',
    `provisionalScore` INTEGER NULL,
    `finalScore` INTEGER NULL,
    `finalDecision` ENUM('PASS', 'PARTIAL', 'FAIL') NULL,
    `reviewedById` VARCHAR(191) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CodingSubmission_assignmentId_idx`(`assignmentId`),
    INDEX `CodingSubmission_studentId_idx`(`studentId`),
    UNIQUE INDEX `CodingSubmission_assignmentId_studentId_attemptNumber_key`(`assignmentId`, `studentId`, `attemptNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CodingSubmissionFile` (
    `id` VARCHAR(191) NOT NULL,
    `submissionId` VARCHAR(191) NOT NULL,
    `path` TEXT NOT NULL,
    `size` INTEGER NOT NULL,
    `language` VARCHAR(191) NULL,

    INDEX `CodingSubmissionFile_submissionId_idx`(`submissionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CodingAiReview` (
    `id` VARCHAR(191) NOT NULL,
    `submissionId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `model` VARCHAR(191) NOT NULL,
    `promptVersion` VARCHAR(191) NOT NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'DONE', 'ERROR') NOT NULL DEFAULT 'QUEUED',
    `score` INTEGER NULL,
    `confidence` ENUM('HIGH', 'MEDIUM', 'LOW') NULL,
    `summary` TEXT NULL,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CodingAiReview_submissionId_idx`(`submissionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CodingAiFinding` (
    `id` VARCHAR(191) NOT NULL,
    `reviewId` VARCHAR(191) NOT NULL,
    `kind` ENUM('BUG', 'SECURITY', 'QUALITY', 'ARCHITECTURE', 'STRENGTH') NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `body` TEXT NOT NULL,
    `confidence` ENUM('HIGH', 'MEDIUM', 'LOW') NOT NULL DEFAULT 'MEDIUM',

    INDEX `CodingAiFinding_reviewId_idx`(`reviewId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CodingRequirementResult` (
    `id` VARCHAR(191) NOT NULL,
    `reviewId` VARCHAR(191) NOT NULL,
    `requirementId` VARCHAR(191) NOT NULL,
    `verdict` ENUM('PASS', 'PARTIAL', 'FAIL') NOT NULL,

    INDEX `CodingRequirementResult_reviewId_idx`(`reviewId`),
    INDEX `CodingRequirementResult_requirementId_idx`(`requirementId`),
    UNIQUE INDEX `CodingRequirementResult_reviewId_requirementId_key`(`reviewId`, `requirementId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CodingFeedback` (
    `id` VARCHAR(191) NOT NULL,
    `submissionId` VARCHAR(191) NOT NULL,
    `authorId` VARCHAR(191) NOT NULL,
    `body` TEXT NOT NULL,
    `filePath` TEXT NULL,
    `line` INTEGER NULL,
    `visibleToStudent` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CodingFeedback_submissionId_idx`(`submissionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CodingAssignment` ADD CONSTRAINT `CodingAssignment_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `Course`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CodingAssignment` ADD CONSTRAINT `CodingAssignment_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `LiveSession`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CodingAssignment` ADD CONSTRAINT `CodingAssignment_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CodingRequirement` ADD CONSTRAINT `CodingRequirement_assignmentId_fkey` FOREIGN KEY (`assignmentId`) REFERENCES `CodingAssignment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CodingRubricItem` ADD CONSTRAINT `CodingRubricItem_assignmentId_fkey` FOREIGN KEY (`assignmentId`) REFERENCES `CodingAssignment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CodingSubmission` ADD CONSTRAINT `CodingSubmission_assignmentId_fkey` FOREIGN KEY (`assignmentId`) REFERENCES `CodingAssignment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CodingSubmission` ADD CONSTRAINT `CodingSubmission_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CodingSubmission` ADD CONSTRAINT `CodingSubmission_reviewedById_fkey` FOREIGN KEY (`reviewedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CodingSubmissionFile` ADD CONSTRAINT `CodingSubmissionFile_submissionId_fkey` FOREIGN KEY (`submissionId`) REFERENCES `CodingSubmission`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CodingAiReview` ADD CONSTRAINT `CodingAiReview_submissionId_fkey` FOREIGN KEY (`submissionId`) REFERENCES `CodingSubmission`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CodingAiFinding` ADD CONSTRAINT `CodingAiFinding_reviewId_fkey` FOREIGN KEY (`reviewId`) REFERENCES `CodingAiReview`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CodingRequirementResult` ADD CONSTRAINT `CodingRequirementResult_reviewId_fkey` FOREIGN KEY (`reviewId`) REFERENCES `CodingAiReview`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CodingRequirementResult` ADD CONSTRAINT `CodingRequirementResult_requirementId_fkey` FOREIGN KEY (`requirementId`) REFERENCES `CodingRequirement`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CodingFeedback` ADD CONSTRAINT `CodingFeedback_submissionId_fkey` FOREIGN KEY (`submissionId`) REFERENCES `CodingSubmission`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CodingFeedback` ADD CONSTRAINT `CodingFeedback_authorId_fkey` FOREIGN KEY (`authorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
