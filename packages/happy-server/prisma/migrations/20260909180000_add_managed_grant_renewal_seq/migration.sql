-- Additive only: a monotonic renewal counter on managed session grants.
ALTER TABLE "ManagedSessionGrant" ADD COLUMN "renewalSeq" INTEGER NOT NULL DEFAULT 0;
