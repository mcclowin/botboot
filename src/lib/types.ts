/**
 * Shared Hono environment type for authenticated routes.
 */
export type AuthEnv = {
  Variables: {
    accountId: string;
    accountEmail: string;
  };
};
