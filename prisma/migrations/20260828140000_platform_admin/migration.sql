-- Platform admin: super-admin flag, audit trail, and AI usage tracking.
-- Additive only (no drops) so it applies cleanly over the live schema.

-- 1. Super-admin flag on User (defaults false; granted only by another super-admin).
ALTER TABLE `User` ADD COLUMN `isSuperAdmin` BOOLEAN NOT NULL DEFAULT false;

-- 2. Immutable audit trail.
CREATE TABLE `AuditLog` (
    `id` VARCHAR(191) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actorId` VARCHAR(191) NULL,
    `actorEmail` VARCHAR(191) NULL,
    `actorRole` VARCHAR(191) NULL,
    `orgId` VARCHAR(191) NULL,
    `action` VARCHAR(191) NOT NULL,
    `targetType` VARCHAR(191) NULL,
    `targetId` VARCHAR(191) NULL,
    `metadata` JSON NULL,
    `ip` VARCHAR(191) NULL,
    `userAgent` TEXT NULL,

    INDEX `AuditLog_at_idx`(`at`),
    INDEX `AuditLog_action_at_idx`(`action`, `at`),
    INDEX `AuditLog_actorId_at_idx`(`actorId`, `at`),
    INDEX `AuditLog_orgId_at_idx`(`orgId`, `at`),
    INDEX `AuditLog_targetType_targetId_idx`(`targetType`, `targetId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 3. AI-model usage + estimated cost, one row per call.
CREATE TABLE `AiUsage` (
    `id` VARCHAR(191) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `feature` ENUM('CODING_REVIEW', 'ASSESSMENT_DRAFT') NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `model` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NULL,
    `userId` VARCHAR(191) NULL,
    `promptTokens` INTEGER NOT NULL DEFAULT 0,
    `outputTokens` INTEGER NOT NULL DEFAULT 0,
    `totalTokens` INTEGER NOT NULL DEFAULT 0,
    `estCostUsd` DECIMAL(12, 6) NOT NULL DEFAULT 0,
    `refId` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'ok',

    INDEX `AiUsage_at_idx`(`at`),
    INDEX `AiUsage_feature_at_idx`(`feature`, `at`),
    INDEX `AiUsage_model_at_idx`(`model`, `at`),
    INDEX `AiUsage_orgId_at_idx`(`orgId`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
