CREATE TABLE "rate_counters" (
	"user_id" text NOT NULL,
	"bucket" text NOT NULL,
	"window_start" integer NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_counters_user_id_bucket_window_start_pk" PRIMARY KEY("user_id","bucket","window_start")
);
