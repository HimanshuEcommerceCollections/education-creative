ALTER TABLE "sessions" DROP COLUMN "mfa_satisfied_at";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "mfa_secret";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "mfa_enrolled_at";