export type RequestRoute = "ignore" | "navigation" | "runtime";

export interface RequestDescriptor {
  method: string;
  mode?: string;
  url: string;
}

export function classifyRequest(request: RequestDescriptor, scopeUrl: string): RequestRoute {
  if (request.method !== "GET") return "ignore";
  const requestUrl = new URL(request.url);
  const scope = new URL(scopeUrl);
  if (requestUrl.origin !== scope.origin) return "ignore";
  return request.mode === "navigate" ? "navigation" : "runtime";
}
