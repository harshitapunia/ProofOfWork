/** Existing backend routes only. Workspace selection conveys no server role. */
export const AUTH_ROUTES = Object.freeze({
  challenge: "/api/v1/auth/challenge",
  verify: "/api/v1/auth/verify",
  logout: "/api/v1/auth/logout",
});
export const uuid = (s: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s);
export function jobRoutes(id: string) {
  if (!uuid(id)) throw new Error("Invalid job ID");
  const job = `/api/v1/jobs/${id}`;
  return Object.freeze({ job, milestone: job + "/milestone", execution: job + "/execution" });
}
