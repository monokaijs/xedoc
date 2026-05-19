import "dotenv/config"
import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto"
import { Prisma } from "@prisma/client"
import type {
  AuthExchangeResponse,
  AuthStatusResponse,
  AuthSessionResponse,
  AuthTokenPayload,
} from "@/types"
import { HttpError } from "./http.server"
import { prisma } from "./prisma.server"

const SERVER_AUTH_ID = "server"
const PASSWORD_HASH_ALGORITHM = "scrypt"
const PASSWORD_KEY_LENGTH = 64
const PASSWORD_MIN_LENGTH = 8

export async function readAuthStatus(): Promise<AuthStatusResponse> {
  return { passwordConfigured: !!(await readServerAuth()) }
}

export async function exchangePassword(
  password: string,
): Promise<AuthExchangeResponse> {
  requireValidPassword(password)

  const auth = (await readServerAuth()) ?? (await createServerAuth(password))
  if (!verifyPassword(password, auth.passwordHash)) {
    throw new HttpError(401, "Invalid server password.")
  }

  return {
    token: signToken(
      {
        authHash: currentAuthHash(auth.passwordHash),
        issuedAt: new Date().toISOString(),
      },
      auth.tokenSecret,
    ),
  }
}

export async function readSession(request: Request): Promise<AuthSessionResponse> {
  const payload = await verifyRequest(request)
  return { authenticated: true, issuedAt: payload.issuedAt }
}

export async function verifyRequest(request: Request): Promise<AuthTokenPayload> {
  return verifyBearer(request.headers.get("authorization") ?? undefined)
}

export async function verifyBearer(
  authorization: string | undefined,
): Promise<AuthTokenPayload> {
  return verifyToken(extractBearerToken(authorization), await requireServerAuth())
}

function signToken(payload: AuthTokenPayload, tokenSecret: string): string {
  const encodedPayload = encodeBase64Url(JSON.stringify(payload))
  const signature = sign(encodedPayload, tokenSecret)
  return `${encodedPayload}.${signature}`
}

function verifyToken(
  token: string,
  auth: { passwordHash: string; tokenSecret: string },
): AuthTokenPayload {
  const [encodedPayload, signature, extra] = token.split(".")
  if (!encodedPayload || !signature || extra !== undefined) {
    throw new HttpError(401, "Invalid auth token.")
  }

  if (!constantTimeEqual(signature, sign(encodedPayload, auth.tokenSecret))) {
    throw new HttpError(401, "Invalid auth token.")
  }

  const payload = parsePayload(encodedPayload)
  if (payload.authHash !== currentAuthHash(auth.passwordHash)) {
    throw new HttpError(401, "Auth token has been revoked.")
  }
  return payload
}

function extractBearerToken(authorization: string | undefined): string {
  const [scheme, token] = authorization?.split(" ") ?? []
  if (scheme !== "Bearer" || !token) {
    throw new HttpError(401, "Missing auth token.")
  }
  return token
}

function parsePayload(encodedPayload: string): AuthTokenPayload {
  try {
    const value = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<AuthTokenPayload>
    if (typeof value.authHash !== "string" || typeof value.issuedAt !== "string") {
      throw new Error("Invalid payload.")
    }
    return { authHash: value.authHash, issuedAt: value.issuedAt }
  } catch {
    throw new HttpError(401, "Invalid auth token.")
  }
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

function currentAuthHash(passwordHash: string): string {
  return hash(passwordHash)
}

function sign(value: string, tokenSecret: string): string {
  return createHmac("sha256", tokenSecret).update(value).digest("base64url")
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

async function requireServerAuth() {
  const auth = await readServerAuth()
  if (!auth) {
    throw new HttpError(401, "Server password has not been configured.")
  }
  return auth
}

async function readServerAuth() {
  return prisma.serverAuth.findUnique({ where: { id: SERVER_AUTH_ID } })
}

async function createServerAuth(password: string) {
  try {
    return await prisma.serverAuth.create({
      data: {
        id: SERVER_AUTH_ID,
        passwordHash: hashPassword(password),
        tokenSecret: randomSecret(32),
      },
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new HttpError(
        409,
        "Server password was already configured. Sign in with the configured password.",
      )
    }
    throw error
  }
}

function requireValidPassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new HttpError(
      400,
      `Server password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    )
  }
}

function hashPassword(password: string): string {
  const salt = randomSecret(16)
  const key = scryptSync(password, salt, PASSWORD_KEY_LENGTH).toString(
    "base64url",
  )
  return `${PASSWORD_HASH_ALGORITHM}:${salt}:${key}`
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [algorithm, salt, expectedKey, extra] = storedHash.split(":")
  if (
    algorithm !== PASSWORD_HASH_ALGORITHM ||
    !salt ||
    !expectedKey ||
    extra !== undefined
  ) {
    return false
  }

  const actualKey = scryptSync(password, salt, PASSWORD_KEY_LENGTH).toString(
    "base64url",
  )
  return constantTimeEqual(actualKey, expectedKey)
}

function randomSecret(bytes: number): string {
  return randomBytes(bytes).toString("base64url")
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  )
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  )
}
