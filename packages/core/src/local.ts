// "Only on your own machine" (review S8, S11, S18). The demo model, the local operator
// sign-in and the test faults are refused anywhere else. One check for all of them:
// nothing says the process runs on a hosting platform, the database is on this machine,
// and so are Temporal and the app's own address when they are set. A deployment that
// reaches its database through a local proxy still fails on one of the others.

export const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Variables that hosting platforms set in every app they run. */
const HOSTING_MARKERS = [
  "CONTAINER_APP_NAME", // Azure Container Apps (apps)
  "CONTAINER_APP_JOB_NAME", // Azure Container Apps (jobs)
  "WEBSITE_SITE_NAME", // Azure App Service
  // Kubernetes, including AKS. Also set on CI runners hosted on Kubernetes (Actions
  // Runner Controller): there the e2e tests and the quick start are refused too.
  "KUBERNETES_SERVICE_HOST",
  "AWS_EXECUTION_ENV", // AWS Lambda, ECS, App Runner
  "ECS_CONTAINER_METADATA_URI_V4", // AWS ECS
  "K_SERVICE", // Google Cloud Run
  "FLY_APP_NAME", // Fly.io
  "RENDER", // Render
  "DYNO", // Heroku
];

/** The host name of a URL or of a bare "host:port" address; "" if it has none. */
export function hostOf(addressOrUrl: string): string {
  try {
    const url = addressOrUrl.includes("://") ? addressOrUrl : `tcp://${addressOrUrl}`;
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Whether a URL or "host:port" address is on this machine. */
export function isLocalAddress(addressOrUrl: string): boolean {
  // A Postgres URL's ?host= wins over its host (postgres.js connects there), so it alone
  // decides: a socket path ("/var/run/postgresql") is this machine; a name must be local.
  // A URL refuses a user name with no host, so the user name goes first.
  try {
    const url = new URL(addressOrUrl.replace(/^([a-z]+:\/\/)[^/@]*@\//, "$1/"));
    const hosts = url.searchParams.get("host");
    if (hosts !== null) {
      return hosts.split(",").every((h) => h.startsWith("/") || LOCAL_HOSTS.has(hostOf(h.trim())));
    }
  } catch {
    // Not a URL: a "host:port" address.
  }
  return LOCAL_HOSTS.has(hostOf(addressOrUrl));
}

/**
 * Why this process is not on a developer's own machine, or null if it is. The reason
 * names a setting, never its value.
 */
export function notLocalReason(env: Record<string, string | undefined>): string | null {
  const marker = HOSTING_MARKERS.find((name) => env[name]);
  if (marker) return `${marker} is set, so this runs on a hosting platform`;
  if (!isLocalAddress(env["DATABASE_URL"] ?? "")) return "DATABASE_URL is not on this machine";
  for (const name of ["TEMPORAL_ADDRESS", "AUTH_URL"]) {
    const value = env[name]?.trim();
    if (value && !isLocalAddress(value)) return `${name} is not on this machine`;
  }
  return null;
}
