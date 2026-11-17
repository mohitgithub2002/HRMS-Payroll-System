-- Ask AI (client add-on): the pass that scopes one question, and the Board's knowledge base.

-- CreateEnum
CREATE TYPE "KnowledgeAudience" AS ENUM ('EVERYONE', 'STAFF', 'ADMIN');

-- CreateTable
CREATE TABLE "AskGrant" (
    "token" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "employeeId" TEXT,
    "sectionId" TEXT,
    "pensionerId" TEXT,
    "scopes" JSONB NOT NULL,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AskGrant_pkey" PRIMARY KEY ("token"),
    -- A token short enough to guess must never open anything.
    CONSTRAINT "AskGrant_token_length" CHECK (length("token") >= 40)
);

-- CreateTable
CREATE TABLE "KnowledgeDoc" (
    "id" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'POLICY',
    "reference" TEXT,
    "body" TEXT NOT NULL,
    "audience" "KnowledgeAudience" NOT NULL DEFAULT 'EVERYONE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDoc_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AskGrant_expiresAt_idx" ON "AskGrant"("expiresAt");

-- CreateIndex
CREATE INDEX "KnowledgeDoc_boardId_isActive_idx" ON "KnowledgeDoc"("boardId", "isActive");
