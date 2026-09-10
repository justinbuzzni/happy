-- A renewal needs its own request identity.
--
-- Overwriting `requestId` on renewal left `bodyDigest` describing the original
-- issue while the id described the renewal: a retry of the original issue then
-- found no row by request id and collided on the unique index instead of
-- converging on what it had already produced.
ALTER TABLE "ManagedDaemonGrant" ADD COLUMN "renewalRequestId" TEXT;
ALTER TABLE "ManagedDaemonGrant" ADD COLUMN "renewalBodyDigest" TEXT;

CREATE UNIQUE INDEX "ManagedDaemonGrant_renewalRequestId_key"
    ON "ManagedDaemonGrant"("renewalRequestId");
