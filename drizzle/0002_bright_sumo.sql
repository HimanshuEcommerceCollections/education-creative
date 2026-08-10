CREATE TYPE "public"."booking_format" AS ENUM('in_home', 'online');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('pending_payment', 'paid_unconfirmed', 'confirmed', 'completed', 'no_show', 'refunded', 'partially_refunded', 'disputed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."learner_age_band" AS ENUM('4-6', '7-9', '10-12', '13-15', '16-18');--> statement-breakpoint
CREATE TYPE "public"."ledger_account" AS ENUM('platform_revenue', 'educator_earnings_accrued', 'stripe_fee', 'refund', 'dispute');--> statement-breakpoint
CREATE TYPE "public"."ledger_status" AS ENUM('accrued', 'at_risk', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('requires_payment', 'processing', 'succeeded', 'refunded', 'partially_refunded', 'failed', 'canceled', 'disputed');--> statement-breakpoint
CREATE TABLE "educator_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"educator_profile_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"rate_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "format_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"in_home_multiplier_bps" integer DEFAULT 10000 NOT NULL,
	"travel_flat_cents" integer DEFAULT 0 NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subject_rate_bands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject_id" uuid NOT NULL,
	"min_cents" integer NOT NULL,
	"suggested_cents" integer NOT NULL,
	"max_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subjects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"learner_id" uuid NOT NULL,
	"educator_profile_id" uuid NOT NULL,
	"assigned_educator_id" uuid,
	"subject_id" uuid NOT NULL,
	"subject_topic" text NOT NULL,
	"format" "booking_format" NOT NULL,
	"duration_minutes" integer NOT NULL,
	"preferred_date" text NOT NULL,
	"preferred_time" text NOT NULL,
	"alternate_time" text,
	"flexible_time" boolean DEFAULT false NOT NULL,
	"address_encrypted" text,
	"status" "booking_status" DEFAULT 'pending_payment' NOT NULL,
	"currency" text NOT NULL,
	"frozen_quote" jsonb NOT NULL,
	"total_cents" integer NOT NULL,
	"take_rate_bps_snapshot" integer NOT NULL,
	"educator_earnings_cents" integer NOT NULL,
	"platform_margin_cents" integer NOT NULL,
	"sla_deadline" timestamp with time zone NOT NULL,
	"coordinator_id" uuid,
	"confirmed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learners" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"first_name_encrypted" text NOT NULL,
	"age_band" "learner_age_band" NOT NULL,
	"focus_encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"booking_id" uuid NOT NULL,
	"account" "ledger_account" NOT NULL,
	"direction" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"status" "ledger_status" DEFAULT 'accrued' NOT NULL,
	"related_stripe_object_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"booking_id" uuid NOT NULL,
	"stripe_checkout_session_id" text,
	"stripe_payment_intent_id" text,
	"stripe_charge_id" text,
	"stripe_balance_transaction_id" text,
	"status" "payment_status" DEFAULT 'requires_payment' NOT NULL,
	"currency" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"amount_received_cents" integer DEFAULT 0 NOT NULL,
	"amount_refunded_cents" integer DEFAULT 0 NOT NULL,
	"stripe_fee_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"educator_profile_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"subject_topic" text NOT NULL,
	"format" "booking_format" NOT NULL,
	"duration_minutes" integer NOT NULL,
	"currency" text NOT NULL,
	"line_items" jsonb NOT NULL,
	"total_cents" integer NOT NULL,
	"effective_rate_per_hour_cents" integer NOT NULL,
	"take_rate_bps" integer NOT NULL,
	"educator_earnings_cents" integer NOT NULL,
	"platform_margin_cents" integer NOT NULL,
	"expected_fee_cents" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_booking_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"stripe_event_id" text NOT NULL,
	"type" text NOT NULL,
	"project" text,
	"handled" boolean DEFAULT false NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "educator_profiles" ADD COLUMN "subjects" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "educator_rates" ADD CONSTRAINT "educator_rates_educator_profile_id_educator_profiles_id_fk" FOREIGN KEY ("educator_profile_id") REFERENCES "public"."educator_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "educator_rates" ADD CONSTRAINT "educator_rates_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "educator_rates" ADD CONSTRAINT "educator_rates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "format_policies" ADD CONSTRAINT "format_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_rate_bands" ADD CONSTRAINT "subject_rate_bands_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_rate_bands" ADD CONSTRAINT "subject_rate_bands_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_profile_id_customer_profiles_id_fk" FOREIGN KEY ("customer_profile_id") REFERENCES "public"."customer_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_learner_id_learners_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_educator_profile_id_educator_profiles_id_fk" FOREIGN KEY ("educator_profile_id") REFERENCES "public"."educator_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_assigned_educator_id_educator_profiles_id_fk" FOREIGN KEY ("assigned_educator_id") REFERENCES "public"."educator_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_coordinator_id_users_id_fk" FOREIGN KEY ("coordinator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learners" ADD CONSTRAINT "learners_customer_profile_id_customer_profiles_id_fk" FOREIGN KEY ("customer_profile_id") REFERENCES "public"."customer_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_profile_id_customer_profiles_id_fk" FOREIGN KEY ("customer_profile_id") REFERENCES "public"."customer_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_educator_profile_id_educator_profiles_id_fk" FOREIGN KEY ("educator_profile_id") REFERENCES "public"."educator_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "educator_rates_educator_idx" ON "educator_rates" USING btree ("educator_profile_id","subject_id","effective_to");--> statement-breakpoint
CREATE INDEX "format_policies_effective_idx" ON "format_policies" USING btree ("effective_to");--> statement-breakpoint
CREATE INDEX "subject_rate_bands_subject_idx" ON "subject_rate_bands" USING btree ("subject_id","effective_to");--> statement-breakpoint
CREATE UNIQUE INDEX "subjects_slug_key" ON "subjects" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_reference_key" ON "bookings" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "bookings_customer_idx" ON "bookings" USING btree ("customer_profile_id");--> statement-breakpoint
CREATE INDEX "bookings_status_idx" ON "bookings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bookings_educator_idx" ON "bookings" USING btree ("educator_profile_id");--> statement-breakpoint
CREATE INDEX "bookings_assigned_idx" ON "bookings" USING btree ("assigned_educator_id");--> statement-breakpoint
CREATE INDEX "bookings_sla_idx" ON "bookings" USING btree ("sla_deadline") WHERE status = 'paid_unconfirmed';--> statement-breakpoint
CREATE INDEX "learners_customer_idx" ON "learners" USING btree ("customer_profile_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_booking_idx" ON "ledger_entries" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" USING btree ("account","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_intent_key" ON "payments" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_checkout_session_key" ON "payments" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE INDEX "payments_booking_idx" ON "payments" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_live_per_booking" ON "payments" USING btree ("booking_id") WHERE status in ('requires_payment', 'processing');--> statement-breakpoint
CREATE INDEX "quotes_customer_idx" ON "quotes" USING btree ("customer_profile_id");--> statement-breakpoint
CREATE INDEX "quotes_expires_idx" ON "quotes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_webhook_events_event_key" ON "stripe_webhook_events" USING btree ("stripe_event_id");--> statement-breakpoint
CREATE INDEX "stripe_webhook_events_type_idx" ON "stripe_webhook_events" USING btree ("type");