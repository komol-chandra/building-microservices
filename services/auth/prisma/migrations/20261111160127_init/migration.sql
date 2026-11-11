-- CreateEnum
CREATE TYPE "Role" AS ENUM ('user', 'admin');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'user',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SigningKey" (
    "kid" TEXT NOT NULL,
    "privateJwk" JSONB NOT NULL,
    "publicJwk" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "SigningKey_pkey" PRIMARY KEY ("kid")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- Demo users (added by hand). SAME ids as the old hard-coded gateway users, so
-- orders placed before Phase 9 still belong to them. Passwords: admin123 / user123.
INSERT INTO "User" ("id", "email", "name", "passwordHash", "role", "updatedAt") VALUES
  ('11111111-1111-4111-8111-111111111111', 'admin@shop.test', 'Shop Admin',
   'scrypt$16384$8$1$ZsWzzP6oaVRSmZASsQYv+Q==$F2Mr6RK36c7/mWNri2yQqVyO22vCU9c5YQw1ixI9HroPeIGVzRJXMlYaXI8JkuJjIyTs4klQgfY3N4h9MeVdrA==',
   'admin', CURRENT_TIMESTAMP),
  ('22222222-2222-4222-8222-222222222222', 'user@shop.test', 'Demo User',
   'scrypt$16384$8$1$K2lehIFOzWmeQDKfb6UhBw==$OfRFewxpg2+Su2uz7buQVwY+qLtbvd2N8042khrKRyVxl8dcM6jBYPAYy2FJ5lTFSxwx50ud9Cy1rCE0yQtmPA==',
   'user', CURRENT_TIMESTAMP);
