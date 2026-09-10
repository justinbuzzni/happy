-- Re-adding a removed member has to work, and must not resurrect their old
-- bearer.
--
-- A read grant's family is derived from the ACL generation it was issued under,
-- so a removal tombstones generation N and a re-add issues under N+1: a
-- different row. The alternative — clearing the tombstone — would revive the
-- credential the removal withdrew.
ALTER TABLE "ManagedSessionGrant" ADD COLUMN "aclRevision" INTEGER;

-- The compare-and-set point for every read-grant write.
--
-- Control-plane messages can arrive late in either direction: an old mint would
-- restore withdrawn access, an old revoke would withdraw restored access. Both
-- are refused by comparing against the highest generation seen for this
-- (session, viewer). Per viewer and session rather than per project, so one
-- ACL change does not invalidate every session's readers.
CREATE TABLE "ManagedReadAclWatermark" (
    "sessionId" TEXT NOT NULL,
    "viewerAccountId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "ManagedReadAclWatermark_pkey" PRIMARY KEY ("sessionId","viewerAccountId")
);
