export function oneTrustRequestUrl(tenantUrl: string, requestId: string) {
  const tenant = tenantUrl.replace(/\/$/, "");
  return `${tenant}/app/#/pia/dsar/requests?requestQueueRefId=${encodeURIComponent(requestId)}`;
}
