import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export const API_SESSION_HEADER = "x-judgedesk-session";
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "tauri://localhost",
]);

export interface DesktopApiBoundary {
  port: number;
  token: string;
}

export interface DesktopApiRequestIdentity {
  method: string;
  host?: string;
  origin?: string;
  token?: string;
}

export type DesktopApiAuthorization =
  | { ok: true; status?: never; code?: never }
  | { ok: false; status: 401 | 403; code: "API_SESSION_REQUIRED" | "API_HOST_REJECTED" | "API_ORIGIN_REJECTED" };

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual || !TOKEN_PATTERN.test(actual) || !TOKEN_PATTERN.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "ascii"), Buffer.from(expected, "ascii"));
}

export function consumeApiSessionToken(
  environment: NodeJS.ProcessEnv,
  production: boolean,
): string | null {
  const token = environment.JUDGEDESK_API_TOKEN;
  delete environment.JUDGEDESK_API_TOKEN;
  if (token === undefined && !production) return null;
  if (!token || !TOKEN_PATTERN.test(token)) {
    throw new Error("JudgeDesk API session token is missing or invalid.");
  }
  return token;
}

export interface ApiSessionTokenStore {
  consume(environment: NodeJS.ProcessEnv, production: boolean): string | null;
}

export function createApiSessionTokenStore(): ApiSessionTokenStore {
  let token: string | null | undefined;
  return {
    consume(environment, production) {
      if (token === undefined) {
        token = consumeApiSessionToken(environment, production);
      }
      return token;
    },
  };
}

export const processApiSessionTokenStore = createApiSessionTokenStore();

export function authorizeDesktopApiRequest(
  request: DesktopApiRequestIdentity,
  boundary: DesktopApiBoundary,
): DesktopApiAuthorization {
  if (request.host !== `127.0.0.1:${boundary.port}`) {
    return { ok: false, status: 403, code: "API_HOST_REJECTED" };
  }
  if (request.origin !== undefined && !ALLOWED_ORIGINS.has(request.origin)) {
    return { ok: false, status: 403, code: "API_ORIGIN_REJECTED" };
  }
  if (request.method.toUpperCase() !== "OPTIONS" && !tokenMatches(request.token, boundary.token)) {
    return { ok: false, status: 401, code: "API_SESSION_REQUIRED" };
  }
  return { ok: true };
}

export function createDesktopApiMiddleware(boundary: DesktopApiBoundary): RequestHandler {
  if (!Number.isSafeInteger(boundary.port) || boundary.port < 1 || boundary.port > 65_535) {
    throw new Error("JudgeDesk API boundary port is invalid.");
  }
  if (!TOKEN_PATTERN.test(boundary.token)) {
    throw new Error("JudgeDesk API boundary token is invalid.");
  }
  return (request, response, next) => {
    const origin = request.headers.origin;
    const authorization = authorizeDesktopApiRequest(
      {
        method: request.method,
        host: request.headers.host,
        origin: typeof origin === "string" ? origin : undefined,
        token: request.get(API_SESSION_HEADER),
      },
      boundary,
    );
    if (!authorization.ok) {
      return response.status(authorization.status).json({
        success: false,
        code: authorization.code,
        message: "JudgeDesk rejected an unauthorized desktop API request.",
      });
    }
    if (typeof origin === "string") {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    response.setHeader(
      "Access-Control-Allow-Headers",
      `Origin, X-Requested-With, Content-Type, Accept, ${API_SESSION_HEADER}`,
    );
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    response.setHeader("Access-Control-Max-Age", "86400");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method === "OPTIONS") return response.sendStatus(204);
    next();
  };
}
