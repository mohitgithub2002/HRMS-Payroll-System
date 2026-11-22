-- Files kept in the database where the disk does not last (Vercel): any server can serve any download.

-- CreateTable
CREATE TABLE "StoredFile" (
    "key" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("key")
);
