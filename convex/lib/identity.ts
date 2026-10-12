/**
 * Identity module facade. The implementation is split by concern:
 *   environment    - process.env validation for signing/Apple configuration
 *   jwt            - JWT/crypto primitives (sign, verify, hashing)
 *   appleIdentity  - Apple Sign-In token exchange and server notifications
 *   sessionTokens  - refresh/access token lifecycle and error responses
 */
export {
  appleIssuer,
  createAppleClientSecret,
  exchangeAppleAuthorizationCode,
  fetchAppleJwks,
  revokeAppleRefreshToken,
  preflightAppleServerNotification,
  verifyAppleIdentityToken,
  verifyAppleServerNotification,
  type AppleIdentity,
  type AppleServerEvent,
  type AppleServerNotification,
} from "./appleIdentity";
export {
  decodeBase64Url,
  encodeBase64Url,
  secureStringEqual,
} from "./jwt";
export { refreshSessionLifetimeMillis } from "./sessionTokens";
export {
  readIdentityEnvironment,
  readSessionSigningEnvironment,
  validateIdentitySigningKeys,
  validateSessionSigningKey,
  type IdentityEnvironment,
  type SessionSigningEnvironment,
} from "./environment";
export {
  decryptAppleRefreshToken,
  encryptAppleRefreshToken,
  generateOpaqueRefreshToken,
  hashAppleSubject,
  hashIdentityRateKey,
  hashLocalE2ESubject,
  hashRefreshToken,
  identityErrorResponse,
  issueNumaAccessToken,
  verifyNumaAccessTokenForTest,
  type EncryptedAppleRefreshToken,
  type SessionTokenClaims,
} from "./sessionTokens";
export { IdentityError } from "./jwt";
