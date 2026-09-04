export function resolveWorkflowEndpoint(configured: string, publicBaseUrl: string, path: string, label: string): string {
  const url = (configured || `${publicBaseUrl.replace(/\/+$/, "")}${path}`).trim();
  if (!url) throw new Error(`${label} is not configured`);
  if (!/^https:\/\//i.test(url)) throw new Error(`${label} must be an HTTPS URL`);
  return url;
}
