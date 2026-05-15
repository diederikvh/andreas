-- Per-user favoriete vrienden (Instagram-stijl: ik markeer iemand als
-- favoriet, los van of zij mij ook zo zien).

CREATE TABLE IF NOT EXISTS "friend_favorites" (
  "user_id" text NOT NULL,
  "friend_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "friend_favorites_pkey" PRIMARY KEY ("user_id", "friend_id"),
  CONSTRAINT "friend_favorites_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade,
  CONSTRAINT "friend_favorites_friend_id_users_id_fk"
    FOREIGN KEY ("friend_id") REFERENCES "public"."users"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "friend_favorites_friend_idx"
  ON "friend_favorites" ("friend_id");
