-- Managed session authority (T04-B). Additive only: three new tables, no
-- change to any existing table, column or index.

-- CreateTable
CREATE TABLE "ManagedWorkspaceAuthority" (
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "runtimeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "bodyDigest" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "ManagedWorkspaceAuthority_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "ManagedRunAuthority" (
    "runId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "currentAttemptId" TEXT NOT NULL,
    "cancelledAt" BIGINT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "bodyDigest" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "ManagedRunAuthority_pkey" PRIMARY KEY ("runId")
);

-- CreateTable
CREATE TABLE "ManagedSessionGrant" (
    "grantId" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "workspaceAuthorityVersion" INTEGER NOT NULL,
    "runAuthorityVersion" INTEGER NOT NULL,
    "expiresAt" BIGINT NOT NULL,
    "revokedAt" BIGINT,
    "revokedReason" TEXT,
    "tombstone" BOOLEAN NOT NULL DEFAULT false,
    "requestId" TEXT NOT NULL,
    "bodyDigest" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "ManagedSessionGrant_pkey" PRIMARY KEY ("grantId")
);

-- CreateIndex
CREATE INDEX "ManagedWorkspaceAuthority_tenantId_projectId_idx" ON "ManagedWorkspaceAuthority"("tenantId", "projectId");

-- CreateIndex
CREATE INDEX "ManagedRunAuthority_workspaceId_idx" ON "ManagedRunAuthority"("workspaceId");

-- CreateIndex
CREATE INDEX "ManagedRunAuthority_accountId_idx" ON "ManagedRunAuthority"("accountId");

-- CreateIndex
CREATE INDEX "ManagedSessionGrant_sessionId_revokedAt_idx" ON "ManagedSessionGrant"("sessionId", "revokedAt");

-- CreateIndex
CREATE INDEX "ManagedSessionGrant_runId_attemptId_idx" ON "ManagedSessionGrant"("runId", "attemptId");

-- CreateIndex
CREATE INDEX "ManagedSessionGrant_workspaceId_epoch_idx" ON "ManagedSessionGrant"("workspaceId", "epoch");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedSessionGrant_family_key" ON "ManagedSessionGrant"("family");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedSessionGrant_requestId_key" ON "ManagedSessionGrant"("requestId");

-- AddForeignKey
ALTER TABLE "ManagedRunAuthority" ADD CONSTRAINT "ManagedRunAuthority_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "ManagedWorkspaceAuthority"("workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedSessionGrant" ADD CONSTRAINT "ManagedSessionGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "ManagedWorkspaceAuthority"("workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedSessionGrant" ADD CONSTRAINT "ManagedSessionGrant_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ManagedRunAuthority"("runId") ON DELETE RESTRICT ON UPDATE CASCADE;
