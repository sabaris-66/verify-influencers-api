/*
  Warnings:

  - Changed the type of `verifiedClaims` on the `Influencer` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "Influencer" DROP COLUMN "verifiedClaims",
ADD COLUMN     "verifiedClaims" INTEGER NOT NULL;
