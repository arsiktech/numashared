// Narrow declarations for the Node built-ins used by the APNs action. The repo's
// dependency contract does not permit adding the optional @types/node package.

declare class Buffer extends Uint8Array {
  static from(value: string | Uint8Array, encoding?: string): Buffer;
  static byteLength(value: string): number;
  toString(encoding?: string): string;
}

declare const process: {
  env: Record<string, string | undefined>;
};

declare module "node:crypto" {
  interface KeyObject {
    export(options: Record<string, unknown>): string | Buffer;
  }

  interface Hash {
    update(value: string): Hash;
    digest(encoding: "hex"): string;
  }

  export function createHash(algorithm: "sha256"): Hash;
  export function generateKeyPairSync(
    type: "ec",
    options: { namedCurve: "prime256v1" },
  ): { privateKey: KeyObject; publicKey: KeyObject };
  export function sign(
    algorithm: "sha256",
    data: Uint8Array,
    key: { key: string; dsaEncoding: "ieee-p1363" },
  ): Buffer;
  export function verify(
    algorithm: "sha256",
    data: Uint8Array,
    key: { key: KeyObject; dsaEncoding: "ieee-p1363" },
    signature: Uint8Array,
  ): boolean;
}

declare module "node:http2" {
  export type OutgoingHttpHeaders = Record<
    string,
    string | number | readonly string[] | undefined
  >;

  type IncomingHttpHeaders = Record<string, string | number | readonly string[] | undefined>;
  type ErrorListener = (error: Error) => void;

  interface ClientHttp2Stream {
    setEncoding(encoding: "utf8"): this;
    on(event: "response", listener: (headers: IncomingHttpHeaders) => void): this;
    on(event: "data", listener: (chunk: string) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: ErrorListener): this;
    close(): void;
    end(body: string): void;
  }

  export interface ClientHttp2Session {
    request(headers: OutgoingHttpHeaders): ClientHttp2Stream;
    once(event: "error", listener: ErrorListener): this;
    off(event: "error", listener: ErrorListener): this;
    close(): void;
  }

  export function connect(origin: string): ClientHttp2Session;
}
