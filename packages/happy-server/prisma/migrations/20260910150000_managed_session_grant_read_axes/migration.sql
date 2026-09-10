-- A transcript outlives the run that produced it.
--
-- Read grants exist for sessions whose run has finished, whose runtime is gone,
-- or which have since been replaced. Requiring the run axes to read one is what
-- made a dormant project unreadable, so they become nullable and only a runner
-- grant carries them.
ALTER TABLE "ManagedSessionGrant" ALTER COLUMN "workspaceId" DROP NOT NULL;
ALTER TABLE "ManagedSessionGrant" ALTER COLUMN "runId" DROP NOT NULL;
ALTER TABLE "ManagedSessionGrant" ALTER COLUMN "attemptId" DROP NOT NULL;
ALTER TABLE "ManagedSessionGrant" ALTER COLUMN "epoch" DROP NOT NULL;
ALTER TABLE "ManagedSessionGrant" ALTER COLUMN "workspaceAuthorityVersion" DROP NOT NULL;
ALTER TABLE "ManagedSessionGrant" ALTER COLUMN "runAuthorityVersion" DROP NOT NULL;

-- Who is reading, when that is not the account that owns the session, and the
-- session key envelope resealed for them. The envelope is produced by whoever
-- holds the plaintext key; this server stores what it is given and never
-- substitutes the owner's.
ALTER TABLE "ManagedSessionGrant" ADD COLUMN "viewerAccountId" TEXT;
ALTER TABLE "ManagedSessionGrant" ADD COLUMN "viewerDataEncryptionKey" BYTEA;
