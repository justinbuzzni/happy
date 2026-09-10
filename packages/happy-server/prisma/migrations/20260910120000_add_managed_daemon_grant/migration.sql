-- The durable identity a managed Cloud daemon runs on.
--
-- Separate from key custody: this row answers whether a daemon may still act,
-- while the Machine's wrapped key answers what it can read. Revoking one must
-- not silently invalidate the other, so they are different rows.
CREATE TABLE "ManagedDaemonGrant" (
    "daemonGrantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "runtimeId" TEXT NOT NULL,
    "provisioningOperationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" BIGINT NOT NULL,
    "revokedAt" BIGINT,
    "revokedReason" TEXT,
    "requestId" TEXT NOT NULL,
    "bodyDigest" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "ManagedDaemonGrant_pkey" PRIMARY KEY ("daemonGrantId")
);

-- One live grant per runtime generation: a re-issue supersedes in place rather
-- than leaving two credentials that both look current.
CREATE UNIQUE INDEX "ManagedDaemonGrant_runtimeId_provisioningOperationId_key"
    ON "ManagedDaemonGrant"("runtimeId", "provisioningOperationId");

CREATE UNIQUE INDEX "ManagedDaemonGrant_requestId_key"
    ON "ManagedDaemonGrant"("requestId");

CREATE INDEX "ManagedDaemonGrant_accountId_machineId_idx"
    ON "ManagedDaemonGrant"("accountId", "machineId");

CREATE INDEX "ManagedDaemonGrant_workspaceId_epoch_idx"
    ON "ManagedDaemonGrant"("workspaceId", "epoch");
