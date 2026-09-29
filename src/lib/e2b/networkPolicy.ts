/**
 * E2B's network API rejects the unspecified IPv4/IPv6 blocks and the IPv4-mapped
 * IPv6 block, even though they are syntactically valid CIDRs. Keep this list
 * aligned with the ranges accepted by E2B; URL/DNS checks provide the matching
 * browser-layer protection for addresses that cannot be expressed here.
 */
export const E2B_BROWSER_DENY_OUT_CIDRS = [
  "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
  "224.0.0.0/4", "240.0.0.0/4", "::1/128", "64:ff9b::/96", "fc00::/7", "fe80::/10", "ff00::/8",
] as const;
