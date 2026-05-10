import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "@/modules/account/users/schema";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
}, t => [
  index("idx_sessions_user").on(t.userId),
  index("idx_sessions_expires").on(t.expiresAt),
]);

export const pkceChallenges = sqliteTable("pkce_challenges", {
  state: text("state").primaryKey(),
  codeVerifier: text("code_verifier").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, t => [
  index("idx_pkce_expires").on(t.expiresAt),
]);
