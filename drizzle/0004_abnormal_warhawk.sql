CREATE TYPE "public"."contact_reason" AS ENUM('finding_educator', 'pricing', 'booking_help', 'other');--> statement-breakpoint
CREATE TYPE "public"."contact_request_status" AS ENUM('new', 'in_progress', 'resolved', 'spam');--> statement-breakpoint
CREATE TABLE "contact_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"reason" "contact_reason" NOT NULL,
	"message" text NOT NULL,
	"status" "contact_request_status" DEFAULT 'new' NOT NULL,
	"assigned_to" uuid,
	"user_id" uuid,
	"ip" text,
	"user_agent" text,
	"first_responded_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_requests" ADD CONSTRAINT "contact_requests_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_requests" ADD CONSTRAINT "contact_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_requests_status_idx" ON "contact_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "contact_requests_assigned_idx" ON "contact_requests" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "contact_requests_email_idx" ON "contact_requests" USING btree ("email");